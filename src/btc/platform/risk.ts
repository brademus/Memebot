import {
  BtcDirection,
  MarketContext,
  PaperCall,
  PortfolioLimits,
  RiskPlan,
  StrategyCandidate,
  TradingCosts,
} from './types';
import { clamp, safeDiv } from './indicators';

export const PAPER_MARGIN_USD = 100;
export const PLATFORM_MAX_LEVERAGE = 50;
export const DEFAULT_MIN_NET_TARGET_USD = 20;
export const DEFAULT_MAX_PLANNED_LOSS_USD = DEFAULT_MIN_NET_TARGET_USD / 3;

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

function priceMovePct(entry: number, exit: number): number {
  return entry > 0 ? Math.abs(exit - entry) / entry : Infinity;
}

function directionalTarget(entry: number, movePct: number, direction: BtcDirection): number {
  return direction === 'long' ? entry * (1 + movePct) : entry * (1 - movePct);
}

function isTargetWithinReality(candidate: StrategyCandidate, target: number): boolean {
  if (candidate.direction === 'long') return target <= candidate.maximumRealisticTarget && target > candidate.preferredEntry;
  return target >= candidate.maximumRealisticTarget && target < candidate.preferredEntry;
}

function fartherTarget(direction: BtcDirection, first: number, second: number): number {
  return direction === 'long' ? Math.max(first, second) : Math.min(first, second);
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

export function solveRiskPlan(
  context: MarketContext,
  candidate: StrategyCandidate,
  config: CostModelConfig = DEFAULT_COST_MODEL,
): RiskPlan {
  const genericReject = (reasons: string[]): RiskPlan => ({
    approved: false,
    rejectionReasons: reasons,
    marginUsd: PAPER_MARGIN_USD,
    leverage: 0,
    notionalUsd: 0,
    entryPrice: candidate.preferredEntry,
    stopPrice: candidate.structuralStop,
    targetPrice: candidate.initialTarget,
    extendedTargetPrice: candidate.extendedTarget,
    liquidationPrice: 0,
    liquidationBufferPct: 0,
    estimatedRiskUsd: 0,
    estimatedRewardUsd: 0,
    estimatedNetRR: 0,
    estimatedTargetRoiPct: 0,
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
  if (!(stopDistancePct > 0 && stopDistancePct < 0.05)) initialReasons.push('structural stop distance is invalid');
  if (initialReasons.length) return genericReject([...new Set(initialReasons)]);

  const cap = Math.max(1, Math.min(
    PLATFORM_MAX_LEVERAGE,
    candidate.strategyLeverageCap,
    Number(process.env.BTC_MAX_LEVERAGE || PLATFORM_MAX_LEVERAGE),
  ));
  const minRR = Math.max(3, candidate.minimumRR);
  const maxPlannedLoss = Number(process.env.BTC_MAX_PLANNED_LOSS_USD || DEFAULT_MAX_PLANNED_LOSS_USD);
  const minNetTarget = Number(process.env.BTC_MIN_NET_TARGET_USD || DEFAULT_MIN_NET_TARGET_USD);
  const failures = new Set<string>();

  for (let leverage = Math.floor(cap); leverage >= 1; leverage--) {
    const notionalUsd = PAPER_MARGIN_USD * leverage;
    const costs = estimateCosts(context, candidate, leverage, candidate.entryMethod, config);
    const grossRiskUsd = notionalUsd * stopDistancePct;
    const estimatedRiskUsd = grossRiskUsd + Math.max(0, costs.totalEstimatedUsd);
    if (estimatedRiskUsd > maxPlannedLoss + 1e-9) {
      failures.add('structural stop exceeds the planned $6.67 net-loss budget at available leverage');
      continue;
    }

    const requiredNetReward = Math.max(minNetTarget, estimatedRiskUsd * minRR);
    const requiredGrossReward = requiredNetReward + Math.max(0, costs.totalEstimatedUsd);
    const requiredMovePct = safeDiv(requiredGrossReward, notionalUsd, Infinity);
    const requiredTarget = directionalTarget(candidate.preferredEntry, requiredMovePct, candidate.direction);
    const targetPrice = fartherTarget(candidate.direction, candidate.initialTarget, requiredTarget);
    if (!isTargetWithinReality(candidate, targetPrice)) {
      failures.add('the net +20% and 3R target lies beyond the strategy realistic-target boundary');
      continue;
    }

    const targetDistancePct = priceMovePct(candidate.preferredEntry, targetPrice);
    const estimatedRewardUsd = notionalUsd * targetDistancePct - Math.max(0, costs.totalEstimatedUsd);
    const netRR = safeDiv(estimatedRewardUsd, estimatedRiskUsd, 0);
    if (estimatedRewardUsd < minNetTarget || netRR < minRR) {
      failures.add('estimated net reward does not clear both +$20 and 3R');
      continue;
    }

    const liquidationPrice = estimateLiquidationPrice(candidate.preferredEntry, leverage, candidate.direction, config);
    if (!stopSafelyBeforeLiquidation(candidate.preferredEntry, candidate.structuralStop, liquidationPrice)) {
      failures.add('liquidation buffer is too close to the structural stop');
      continue;
    }
    const liquidationBufferPct = Math.abs(candidate.structuralStop - liquidationPrice) / candidate.preferredEntry * 100;

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
      estimatedNetRR: netRR,
      estimatedTargetRoiPct: estimatedRewardUsd / PAPER_MARGIN_USD * 100,
      costs,
    };
  }

  return genericReject(failures.size ? [...failures] : ['no leverage from 1x to the strategy cap satisfies the risk contract']);
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
