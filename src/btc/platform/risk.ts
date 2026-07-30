import {
  ActionableAlertTier,
  BtcDirection,
  MarketContext,
  PaperCall,
  PortfolioLimits,
  RiskPlan,
  StrategyCandidate,
  StrategyExpectancyEvidence,
  StrategyPerformance,
  TradingCosts,
} from './types';
import { clamp, safeDiv } from './indicators';

export const PAPER_MARGIN_USD = 100;
export const PLATFORM_MAX_LEVERAGE = 50;

export const DEFAULT_STANDARD_MIN_NET_ROI_PCT = 6;
export const DEFAULT_STANDARD_MIN_NET_RR = 2.25;
export const DEFAULT_MAX_PLANNED_LOSS_USD = 6;

export const DEFAULT_A_PLUS_MIN_NET_ROI_PCT = 20;
export const DEFAULT_A_PLUS_MIN_NET_RR = 3;
export const DEFAULT_A_PLUS_MIN_CONFIDENCE = 82;
export const DEFAULT_A_PLUS_MIN_EXECUTION_SCORE = 80;
export const DEFAULT_A_PLUS_MAX_SPREAD_BPS = 2;

export const DEFAULT_EXPECTANCY_MIN_RESOLVED_CALLS = 30;
export const DEFAULT_EXPECTANCY_MIN_AVERAGE_R = 0.1;
export const DEFAULT_EXPECTANCY_MIN_PROFIT_FACTOR = 1.1;
export const DEFAULT_RESEARCH_MAX_PLANNED_LOSS_USD = 20 / 3;
export const DEFAULT_MAX_COST_TO_GROSS_RISK = 0.30;

export const DEFAULT_PORTFOLIO_LIMITS: Readonly<PortfolioLimits> = Object.freeze({
  maxActiveActionableCalls: 3,
  maxActiveResearchCallsPerStrategy: 1,
  maxDailyActionableCalls: 12,
  maxDailyNetLossUsd: 30,
  maxTotalNotionalUsd: 7_500,
  maxWeightedLeverage: 30,
  maxLeverage: PLATFORM_MAX_LEVERAGE,
});

export interface CostModelConfig {
  takerFeeRate: number;
  makerFeeRate: number;
  maintenanceMarginRate: number;
  liquidationFeeBufferRate: number;
}

export const DEFAULT_COST_MODEL: Readonly<CostModelConfig> = Object.freeze({
  takerFeeRate: 0.00055,
  makerFeeRate: 0.0002,
  maintenanceMarginRate: 0.005,
  liquidationFeeBufferRate: 0.001,
});

function numberSetting(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function priceMovePct(entry: number, exit: number): number {
  return entry > 0 ? Math.abs(exit - entry) / entry : Infinity;
}

export function stopIsDirectional(entry: number, stop: number, direction: BtcDirection): boolean {
  if (!(entry > 0 && stop > 0)) return false;
  return direction === 'long' ? stop < entry : stop > entry;
}

function nativeRealisticTarget(candidate: StrategyCandidate): number {
  return candidate.direction === 'long'
    ? Math.min(candidate.initialTarget, candidate.maximumRealisticTarget)
    : Math.max(candidate.initialTarget, candidate.maximumRealisticTarget);
}

function targetIsDirectional(candidate: StrategyCandidate, target: number): boolean {
  return candidate.direction === 'long'
    ? target > candidate.preferredEntry
    : target < candidate.preferredEntry;
}

function estimateCosts(
  context: MarketContext,
  candidate: StrategyCandidate,
  leverage: number,
  entryMethod: StrategyCandidate['entryMethod'],
  config: CostModelConfig,
): TradingCosts {
  const notionalUsd = PAPER_MARGIN_USD * leverage;
  const feeRate = entryMethod === 'limit' ? config.makerFeeRate : config.takerFeeRate;
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

export function estimateLiquidationPrice(
  entry: number,
  leverage: number,
  direction: BtcDirection,
  config: CostModelConfig = DEFAULT_COST_MODEL,
): number {
  const initialMarginRate = 1 / Math.max(leverage, 1);
  const effectiveBuffer = initialMarginRate - config.maintenanceMarginRate - config.liquidationFeeBufferRate;
  if (direction === 'long') return Math.max(0.01, entry * (1 - effectiveBuffer));
  return entry * (1 + effectiveBuffer);
}

function stopSafelyBeforeLiquidation(entry: number, stop: number, liquidation: number): boolean {
  const stopDistance = Math.abs(entry - stop);
  const liquidationDistance = Math.abs(entry - liquidation);
  return liquidationDistance > 0 && stopDistance <= liquidationDistance * 0.65;
}

function candidateConfidence(candidate: StrategyCandidate): number {
  return Math.round(
    candidate.scores.signal * 0.4
    + candidate.scores.regime * 0.25
    + candidate.scores.execution * 0.25
    + candidate.scores.data * 0.1,
  );
}

export function assessStrategyExpectancy(
  performance: StrategyPerformance | null,
): StrategyExpectancyEvidence {
  const requiredResolvedCalls = Math.max(1, Math.floor(numberSetting(
    'BTC_EXPECTANCY_MIN_RESOLVED_CALLS',
    DEFAULT_EXPECTANCY_MIN_RESOLVED_CALLS,
  )));
  const minimumAverageR = numberSetting('BTC_EXPECTANCY_MIN_AVERAGE_R', DEFAULT_EXPECTANCY_MIN_AVERAGE_R);
  const minimumProfitFactor = numberSetting(
    'BTC_EXPECTANCY_MIN_PROFIT_FACTOR',
    DEFAULT_EXPECTANCY_MIN_PROFIT_FACTOR,
  );
  const resolvedCalls = performance ? performance.wins + performance.losses : 0;
  const averageR = performance?.averageR ?? null;
  const profitFactor = performance?.profitFactor ?? null;
  const noObservedLosses = !!performance && performance.wins > 0 && performance.losses === 0;
  const profitFactorPass = profitFactor !== null
    ? profitFactor >= minimumProfitFactor
    : noObservedLosses;
  const ready = !!performance
    && resolvedCalls >= requiredResolvedCalls
    && performance.netPnlUsd > 0
    && averageR !== null
    && averageR >= minimumAverageR
    && profitFactorPass;
  return {
    resolvedCalls,
    requiredResolvedCalls,
    netPnlUsd: performance?.netPnlUsd ?? 0,
    averageR,
    profitFactor,
    minimumAverageR,
    minimumProfitFactor,
    ready,
  };
}

function expectancyRejectionReasons(
  performance: StrategyPerformance | null,
  evidence: StrategyExpectancyEvidence,
): string[] {
  if (!performance) return ['version-specific research expectancy is unavailable'];
  const reasons: string[] = [];
  if (evidence.resolvedCalls < evidence.requiredResolvedCalls) {
    reasons.push(`research expectancy needs ${evidence.requiredResolvedCalls} resolved calls; ${evidence.resolvedCalls} are available`);
  }
  if (!(evidence.netPnlUsd > 0)) reasons.push('version-specific research net P&L is not positive');
  if (evidence.averageR === null || evidence.averageR < evidence.minimumAverageR) {
    reasons.push(`version-specific average R is below ${evidence.minimumAverageR.toFixed(2)}R`);
  }
  const noObservedLosses = performance.wins > 0 && performance.losses === 0;
  if (!noObservedLosses && (evidence.profitFactor === null || evidence.profitFactor < evidence.minimumProfitFactor)) {
    reasons.push(`version-specific profit factor is below ${evidence.minimumProfitFactor.toFixed(2)}`);
  }
  return reasons;
}

function qualifiesForAPlus(
  context: MarketContext,
  candidate: StrategyCandidate,
  estimatedTargetRoiPct: number,
  estimatedNetRR: number,
): boolean {
  const minimumRoiPct = numberSetting('BTC_A_PLUS_MIN_NET_ROI_PCT', DEFAULT_A_PLUS_MIN_NET_ROI_PCT);
  const minimumNetRR = numberSetting('BTC_A_PLUS_MIN_NET_RR', DEFAULT_A_PLUS_MIN_NET_RR);
  const minimumConfidence = numberSetting('BTC_A_PLUS_MIN_CONFIDENCE', DEFAULT_A_PLUS_MIN_CONFIDENCE);
  const minimumExecution = numberSetting(
    'BTC_A_PLUS_MIN_EXECUTION_SCORE',
    DEFAULT_A_PLUS_MIN_EXECUTION_SCORE,
  );
  const maximumSpreadBps = numberSetting('BTC_A_PLUS_MAX_SPREAD_BPS', DEFAULT_A_PLUS_MAX_SPREAD_BPS);
  const liquidMarket = context.regime.liquidity === 'deep' || context.regime.liquidity === 'normal';
  return estimatedTargetRoiPct >= minimumRoiPct
    && estimatedNetRR >= minimumNetRR
    && candidateConfidence(candidate) >= minimumConfidence
    && candidate.scores.execution >= minimumExecution
    && candidate.scores.data >= 90
    && liquidMarket
    && context.regime.event === 'normal'
    && context.feed.spreadBps !== null
    && context.feed.spreadBps <= maximumSpreadBps;
}

export function solveRiskPlan(
  context: MarketContext,
  candidate: StrategyCandidate,
  performance: StrategyPerformance | null = null,
  config: CostModelConfig = DEFAULT_COST_MODEL,
): RiskPlan {
  const targetPrice = nativeRealisticTarget(candidate);
  const expectancyEvidence = assessStrategyExpectancy(performance);
  const genericReject = (reasons: string[]): RiskPlan => ({
    approved: false,
    rejectionReasons: [...new Set(reasons)],
    marginUsd: PAPER_MARGIN_USD,
    leverage: 0,
    notionalUsd: 0,
    entryPrice: candidate.preferredEntry,
    stopPrice: candidate.structuralStop,
    targetPrice,
    extendedTargetPrice: candidate.extendedTarget,
    liquidationPrice: 0,
    liquidationBufferPct: 0,
    estimatedRiskUsd: 0,
    estimatedRewardUsd: 0,
    estimatedNetRR: 0,
    estimatedTargetRoiPct: 0,
    actionableTier: null,
    expectancyEvidence,
    costs: {
      entryFeeUsd: 0, exitFeeUsd: 0, entrySlippageUsd: 0, exitSlippageUsd: 0,
      spreadUsd: 0, expectedFundingUsd: 0, totalEstimatedUsd: 0,
    },
  });

  const initialReasons: string[] = [];
  if (!context.feed.healthy) initialReasons.push(...context.feed.blockers);
  if (candidate.scores.data < 80) initialReasons.push('strategy data-quality score is below 80');
  if (candidate.scores.execution < 50) initialReasons.push('execution-quality score is below 50');
  if (candidateConfidence(candidate) < 68) initialReasons.push('combined candidate confidence is below 68');
  if (candidate.expiresAt <= context.timestamp) initialReasons.push('candidate expired before risk approval');
  const stopDistancePct = priceMovePct(candidate.preferredEntry, candidate.structuralStop);
  if (!stopIsDirectional(candidate.preferredEntry, candidate.structuralStop, candidate.direction)) {
    initialReasons.push('structural stop is on the wrong side of entry');
  }
  if (!(stopDistancePct > 0 && stopDistancePct < 0.05)) initialReasons.push('structural stop distance is invalid');
  if (!targetIsDirectional(candidate, targetPrice)) initialReasons.push('strategy native realistic target is not directional');
  if (!expectancyEvidence.ready) initialReasons.push(...expectancyRejectionReasons(performance, expectancyEvidence));
  if (initialReasons.length) return genericReject(initialReasons);

  const cap = Math.max(1, Math.min(
    PLATFORM_MAX_LEVERAGE,
    candidate.strategyLeverageCap,
    numberSetting('BTC_MAX_LEVERAGE', PLATFORM_MAX_LEVERAGE),
  ));
  const minimumNetRR = numberSetting('BTC_STANDARD_MIN_NET_RR', DEFAULT_STANDARD_MIN_NET_RR);
  const minimumNetRoiPct = numberSetting('BTC_STANDARD_MIN_NET_ROI_PCT', DEFAULT_STANDARD_MIN_NET_ROI_PCT);
  const maxPlannedLoss = numberSetting('BTC_MAX_PLANNED_LOSS_USD', DEFAULT_MAX_PLANNED_LOSS_USD);
  const maximumCostToGrossRisk = numberSetting('BTC_MAX_COST_TO_GROSS_RISK', DEFAULT_MAX_COST_TO_GROSS_RISK);
  const targetDistancePct = priceMovePct(candidate.preferredEntry, targetPrice);
  const failures = new Set<string>();

  for (let leverage = Math.floor(cap); leverage >= 1; leverage--) {
    const notionalUsd = PAPER_MARGIN_USD * leverage;
    const costs = estimateCosts(context, candidate, leverage, candidate.entryMethod, config);
    const estimatedRiskUsd = notionalUsd * stopDistancePct + Math.max(0, costs.totalEstimatedUsd);
    if (estimatedRiskUsd > maxPlannedLoss + 1e-9) {
      failures.add(`structural stop exceeds the planned $${maxPlannedLoss.toFixed(2)} net-loss budget at available leverage`);
      continue;
    }

    const estimatedRewardUsd = notionalUsd * targetDistancePct - Math.max(0, costs.totalEstimatedUsd);
    if (!(estimatedRewardUsd > 0)) {
      failures.add('native strategy target does not remain profitable after estimated costs');
      continue;
    }
    const grossRiskUsd = notionalUsd * stopDistancePct;
    const costToGrossRisk = safeDiv(Math.max(0, costs.totalEstimatedUsd), grossRiskUsd, Infinity);
    if (!(grossRiskUsd > 0) || costToGrossRisk > maximumCostToGrossRisk) {
      failures.add(`modeled round-trip friction exceeds ${(maximumCostToGrossRisk * 100).toFixed(0)}% of gross structural risk`);
      continue;
    }
    const estimatedNetRR = safeDiv(estimatedRewardUsd, estimatedRiskUsd, 0);
    const estimatedTargetRoiPct = estimatedRewardUsd / PAPER_MARGIN_USD * 100;
    if (estimatedTargetRoiPct < minimumNetRoiPct) {
      failures.add(`native strategy target is below the ${minimumNetRoiPct.toFixed(1)}% standard projected net ROI floor`);
      continue;
    }
    if (estimatedNetRR < minimumNetRR) {
      failures.add(`native strategy target is below the ${minimumNetRR.toFixed(2)}R standard net reward-to-risk floor`);
      continue;
    }

    const liquidationPrice = estimateLiquidationPrice(candidate.preferredEntry, leverage, candidate.direction, config);
    if (!stopSafelyBeforeLiquidation(candidate.preferredEntry, candidate.structuralStop, liquidationPrice)) {
      failures.add('liquidation buffer is too close to the structural stop');
      continue;
    }
    const liquidationBufferPct = Math.abs(candidate.structuralStop - liquidationPrice) / candidate.preferredEntry * 100;
    const actionableTier: ActionableAlertTier = qualifiesForAPlus(
      context,
      candidate,
      estimatedTargetRoiPct,
      estimatedNetRR,
    ) ? 'a_plus' : 'standard';

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
      actionableTier,
      expectancyEvidence,
      costs,
    };
  }

  return genericReject(failures.size
    ? [...failures]
    : ['no leverage from 1x to the strategy cap satisfies the tiered actionable risk contract']);
}

export interface PortfolioAssessment {
  approved: boolean;
  reasons: string[];
}

export function assessPortfolioAdmission(
  candidate: StrategyCandidate,
  plan: RiskPlan,
  activeCalls: PaperCall[],
  callsToday: number,
  realizedPnlToday: number,
  limits: PortfolioLimits = DEFAULT_PORTFOLIO_LIMITS,
): PortfolioAssessment {
  const reasons: string[] = [];
  if (!plan.approved) reasons.push(...plan.rejectionReasons);
  const actionable = activeCalls.filter(call => call.book === 'actionable' && ['open', 'partial', 'armed'].includes(call.status));
  if (actionable.length >= limits.maxActiveActionableCalls) reasons.push('maximum active actionable calls reached');
  if (callsToday >= limits.maxDailyActionableCalls) reasons.push('maximum daily actionable calls reached');
  if (realizedPnlToday <= -Math.abs(limits.maxDailyNetLossUsd)) reasons.push('daily portfolio loss circuit breaker is active');
  const activeNotional = actionable.reduce((sum, call) => sum + call.notionalUsd * call.remainingFraction, 0);
  if (activeNotional + plan.notionalUsd > limits.maxTotalNotionalUsd) reasons.push('maximum total actionable notional would be exceeded');
  const weightedLeverage = safeDiv(
    actionable.reduce((sum, call) => sum + call.marginUsd * call.leverage, 0) + plan.marginUsd * plan.leverage,
    actionable.reduce((sum, call) => sum + call.marginUsd, 0) + plan.marginUsd,
    0,
  );
  if (weightedLeverage > limits.maxWeightedLeverage) reasons.push('maximum weighted portfolio leverage would be exceeded');
  if (plan.leverage > limits.maxLeverage) reasons.push('platform leverage ceiling would be exceeded');

  const duplicate = actionable.find(call =>
    call.direction === candidate.direction
    && Math.abs(call.entryPrice - plan.entryPrice) / plan.entryPrice < 0.002
    && call.strategyId === candidate.strategyId,
  );
  if (duplicate) reasons.push('duplicate strategy exposure is already active near the same entry');

  const opposite = actionable.find(call => call.direction !== candidate.direction);
  if (opposite) reasons.push('one-way actionable book already has opposing BTC exposure');

  return { approved: reasons.length === 0, reasons: [...new Set(reasons)] };
}
