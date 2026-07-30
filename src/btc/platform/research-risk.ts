import {
  MarketContext,
  RiskPlan,
  StrategyCandidate,
  TradingCosts,
} from './types';
import { clamp, safeDiv } from './indicators';
import {
  DEFAULT_COST_MODEL,
  DEFAULT_RESEARCH_MAX_PLANNED_LOSS_USD,
  PAPER_MARGIN_USD,
  PLATFORM_MAX_LEVERAGE,
  CostModelConfig,
  estimateLiquidationPrice,
  stopIsDirectional,
} from './risk';

export const DEFAULT_RESEARCH_MIN_NET_ROI_PCT = 4;
export const DEFAULT_RESEARCH_MIN_NET_RR = 1.5;

function numberSetting(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function priceMovePct(entry: number, exit: number): number {
  return entry > 0 ? Math.abs(exit - entry) / entry : Infinity;
}

function candidateConfidence(candidate: StrategyCandidate): number {
  return Math.round(
    candidate.scores.signal * 0.4
    + candidate.scores.regime * 0.25
    + candidate.scores.execution * 0.25
    + candidate.scores.data * 0.1,
  );
}

function nativeRealisticTarget(candidate: StrategyCandidate): number {
  if (candidate.direction === 'long') {
    return Math.min(candidate.initialTarget, candidate.maximumRealisticTarget);
  }
  return Math.max(candidate.initialTarget, candidate.maximumRealisticTarget);
}

function targetIsDirectional(candidate: StrategyCandidate, target: number): boolean {
  return candidate.direction === 'long'
    ? target > candidate.preferredEntry
    : target < candidate.preferredEntry;
}

function estimateResearchCosts(
  context: MarketContext,
  candidate: StrategyCandidate,
  leverage: number,
  config: CostModelConfig,
): TradingCosts {
  const notionalUsd = PAPER_MARGIN_USD * leverage;
  const feeRate = candidate.entryMethod === 'limit' ? config.makerFeeRate : config.takerFeeRate;
  const entryFeeUsd = notionalUsd * feeRate;
  const exitFeeUsd = notionalUsd * config.takerFeeRate;
  const spreadBps = Math.max(context.feed.spreadBps ?? 4, 0);
  const fragilityBps = clamp(context.orderFlow.bookFragility, 0, 1) * 3.5;
  const entrySlippageBps = Math.max(0.35, spreadBps * 0.35 + fragilityBps);
  const exitSlippageBps = Math.max(0.6, spreadBps * 0.5 + fragilityBps * 1.5);
  const entrySlippageUsd = notionalUsd * entrySlippageBps / 10_000;
  const exitSlippageUsd = notionalUsd * exitSlippageBps / 10_000;
  const spreadUsd = notionalUsd * spreadBps / 10_000;
  const fundingIntervals = Math.max(1, Math.ceil(candidate.expectedHoldingMinutes / 480));
  const directionPays = candidate.direction === 'long'
    ? context.derivatives.fundingRate > 0
    : context.derivatives.fundingRate < 0;
  const expectedFundingUsd = directionPays
    ? notionalUsd * Math.abs(context.derivatives.fundingRate) * fundingIntervals
    : -notionalUsd * Math.abs(context.derivatives.fundingRate) * fundingIntervals;
  const totalEstimatedUsd = entryFeeUsd + exitFeeUsd + entrySlippageUsd + exitSlippageUsd + spreadUsd + expectedFundingUsd;
  return {
    entryFeeUsd,
    exitFeeUsd,
    entrySlippageUsd,
    exitSlippageUsd,
    spreadUsd,
    expectedFundingUsd,
    totalEstimatedUsd,
  };
}

function stopSafelyBeforeLiquidation(entry: number, stop: number, liquidation: number): boolean {
  const stopDistance = Math.abs(entry - stop);
  const liquidationDistance = Math.abs(entry - liquidation);
  return liquidationDistance > 0 && stopDistance <= liquidationDistance * 0.65;
}

function rejected(candidate: StrategyCandidate, reasons: string[]): RiskPlan {
  return {
    approved: false,
    rejectionReasons: [...new Set(reasons)],
    marginUsd: PAPER_MARGIN_USD,
    leverage: 0,
    notionalUsd: 0,
    entryPrice: candidate.preferredEntry,
    stopPrice: candidate.structuralStop,
    targetPrice: nativeRealisticTarget(candidate),
    extendedTargetPrice: candidate.extendedTarget,
    liquidationPrice: 0,
    liquidationBufferPct: 0,
    estimatedRiskUsd: 0,
    estimatedRewardUsd: 0,
    estimatedNetRR: 0,
    estimatedTargetRoiPct: 0,
    costs: {
      entryFeeUsd: 0,
      exitFeeUsd: 0,
      entrySlippageUsd: 0,
      exitSlippageUsd: 0,
      spreadUsd: 0,
      expectedFundingUsd: 0,
      totalEstimatedUsd: 0,
    },
  };
}

/**
 * Research calls preserve the strategy's native realistic target instead of
 * forcing actionable evidence maturity or actionable-tier thresholds. Research still requires
 * economically meaningful net ROI and net R after modeled costs, plus feed, confidence, structural-loss
 * and liquidation protections.
 */
export function solveResearchRiskPlan(
  context: MarketContext,
  candidate: StrategyCandidate,
  config: CostModelConfig = DEFAULT_COST_MODEL,
): RiskPlan {
  const reasons: string[] = [];
  if (!context.feed.healthy) reasons.push(...context.feed.blockers);
  if (candidate.scores.data < 80) reasons.push('strategy data-quality score is below 80');
  if (candidate.scores.execution < 50) reasons.push('execution-quality score is below 50');
  if (candidateConfidence(candidate) < 68) reasons.push('combined candidate confidence is below 68');
  if (candidate.expiresAt <= context.timestamp) reasons.push('candidate expired before research risk approval');

  const stopDistancePct = priceMovePct(candidate.preferredEntry, candidate.structuralStop);
  if (!stopIsDirectional(candidate.preferredEntry, candidate.structuralStop, candidate.direction)) {
    reasons.push('structural stop is on the wrong side of entry');
  }
  if (!(stopDistancePct > 0 && stopDistancePct < 0.05)) reasons.push('structural stop distance is invalid');

  const targetPrice = nativeRealisticTarget(candidate);
  if (!targetIsDirectional(candidate, targetPrice)) reasons.push('strategy native realistic target is not directional');
  if (reasons.length) return rejected(candidate, reasons);

  const cap = Math.max(1, Math.min(
    PLATFORM_MAX_LEVERAGE,
    candidate.strategyLeverageCap,
    Number(process.env.BTC_MAX_LEVERAGE || PLATFORM_MAX_LEVERAGE),
  ));
  const maxPlannedLoss = numberSetting('BTC_RESEARCH_MAX_PLANNED_LOSS_USD', DEFAULT_RESEARCH_MAX_PLANNED_LOSS_USD);
  const minimumNetRoiPct = numberSetting('BTC_RESEARCH_MIN_NET_ROI_PCT', DEFAULT_RESEARCH_MIN_NET_ROI_PCT);
  const minimumNetRR = numberSetting('BTC_RESEARCH_MIN_NET_RR', DEFAULT_RESEARCH_MIN_NET_RR);
  const targetDistancePct = priceMovePct(candidate.preferredEntry, targetPrice);
  const failures = new Set<string>();

  for (let leverage = Math.floor(cap); leverage >= 1; leverage--) {
    const notionalUsd = PAPER_MARGIN_USD * leverage;
    const costs = estimateResearchCosts(context, candidate, leverage, config);
    const estimatedRiskUsd = notionalUsd * stopDistancePct + Math.max(0, costs.totalEstimatedUsd);
    if (estimatedRiskUsd > maxPlannedLoss + 1e-9) {
      failures.add('structural stop exceeds the planned $6.67 net-loss budget at available leverage');
      continue;
    }

    const estimatedRewardUsd = notionalUsd * targetDistancePct - Math.max(0, costs.totalEstimatedUsd);
    if (!(estimatedRewardUsd > 0)) {
      failures.add('native strategy target does not remain profitable after estimated costs');
      continue;
    }
    const estimatedNetRR = safeDiv(estimatedRewardUsd, estimatedRiskUsd, 0);
    const estimatedTargetRoiPct = estimatedRewardUsd / PAPER_MARGIN_USD * 100;
    if (estimatedTargetRoiPct < minimumNetRoiPct) {
      failures.add(`research target is below the ${minimumNetRoiPct.toFixed(1)}% projected net ROI quality floor`);
      continue;
    }
    if (estimatedNetRR < minimumNetRR) {
      failures.add(`research target is below the ${minimumNetRR.toFixed(2)}R net reward-to-risk quality floor`);
      continue;
    }

    const liquidationPrice = estimateLiquidationPrice(candidate.preferredEntry, leverage, candidate.direction, config);
    if (!stopSafelyBeforeLiquidation(candidate.preferredEntry, candidate.structuralStop, liquidationPrice)) {
      failures.add('liquidation buffer is too close to the structural stop');
      continue;
    }

    const liquidationBufferPct = Math.abs(candidate.structuralStop - liquidationPrice)
      / candidate.preferredEntry * 100;
    return {
      approved: true,
      rejectionReasons: [],
      marginUsd: PAPER_MARGIN_USD,
      leverage,
      notionalUsd,
      entryPrice: candidate.preferredEntry,
      stopPrice: candidate.structuralStop,
      targetPrice,
      extendedTargetPrice: candidate.extendedTarget,
      liquidationPrice,
      liquidationBufferPct,
      estimatedRiskUsd,
      estimatedRewardUsd,
      estimatedNetRR,
      estimatedTargetRoiPct,
      costs,
    };
  }

  return rejected(candidate, failures.size
    ? [...failures]
    : ['no leverage from 1x to the strategy cap satisfies the research risk contract']);
}
