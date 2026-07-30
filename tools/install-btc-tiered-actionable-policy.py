from pathlib import Path


def replace_exact(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    if old not in text:
        raise SystemExit(f'missing expected text in {path}: {old[:120]!r}')
    file.write_text(text.replace(old, new, 1))


risk = r'''import {
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
    const estimatedNetRR = safeDiv(estimatedRewardUsd, estimatedRiskUsd, 0);
    const estimatedTargetRoiPct = estimatedRewardUsd / PAPER_MARGIN_USD * 100;
    if (!(estimatedRewardUsd > 0)) {
      failures.add('native strategy target does not remain profitable after estimated costs');
      continue;
    }
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
'''
Path('src/btc/platform/risk.ts').write_text(risk)

replace_exact(
    'src/btc/platform/types.ts',
    "export type StrategyMode = 'actionable' | 'shadow';\n",
    "export type StrategyMode = 'actionable' | 'shadow';\nexport type ActionableAlertTier = 'standard' | 'a_plus';\n",
)
replace_exact(
    'src/btc/platform/types.ts',
    "export interface RiskPlan {\n",
    "export interface StrategyExpectancyEvidence {\n  resolvedCalls: number;\n  requiredResolvedCalls: number;\n  netPnlUsd: number;\n  averageR: number | null;\n  profitFactor: number | null;\n  minimumAverageR: number;\n  minimumProfitFactor: number;\n  ready: boolean;\n}\n\nexport interface RiskPlan {\n",
)
replace_exact(
    'src/btc/platform/types.ts',
    "  estimatedTargetRoiPct: number;\n  costs: TradingCosts;\n",
    "  estimatedTargetRoiPct: number;\n  actionableTier?: ActionableAlertTier | null;\n  expectancyEvidence?: StrategyExpectancyEvidence | null;\n  costs: TradingCosts;\n",
)

replace_exact(
    'src/btc/platform/research-risk.ts',
    '  DEFAULT_MAX_PLANNED_LOSS_USD,\n',
    '  DEFAULT_RESEARCH_MAX_PLANNED_LOSS_USD,\n',
)
replace_exact(
    'src/btc/platform/research-risk.ts',
    " * forcing the actionable +$20 and 3R contract. Feed, confidence, structural\n",
    " * forcing actionable evidence maturity, standard ROI, or standard R gates. Feed, confidence, structural\n",
)
replace_exact(
    'src/btc/platform/research-risk.ts',
    "  const maxPlannedLoss = Number(process.env.BTC_MAX_PLANNED_LOSS_USD || DEFAULT_MAX_PLANNED_LOSS_USD);\n",
    "  const maxPlannedLoss = Number(process.env.BTC_RESEARCH_MAX_PLANNED_LOSS_USD || DEFAULT_RESEARCH_MAX_PLANNED_LOSS_USD);\n",
)

replace_exact(
    'src/btc/platform/engine.ts',
    "    const fresh: Array<{\n      candidate: StrategyCandidate;\n      actionablePlan: RiskPlan;\n      researchPlan: RiskPlan;\n    }> = [];\n",
    "    const fresh: Array<{\n      candidate: StrategyCandidate;\n      actionablePlan: RiskPlan;\n      researchPlan: RiskPlan;\n    }> = [];\n    const evidenceByVersion = new Map(this.performance.map(item => [\n      `${item.strategyId}:${item.strategyVersion}`,\n      item,\n    ]));\n",
)
replace_exact(
    'src/btc/platform/engine.ts',
    "        actionablePlan: solveRiskPlan(context, candidate),\n",
    "        actionablePlan: solveRiskPlan(\n          context,\n          candidate,\n          evidenceByVersion.get(`${candidate.strategyId}:${candidate.strategyVersion}`) || null,\n        ),\n",
)

replace_exact(
    'src/btc/platform/execution.ts',
    "      estimatedTargetRoiPct: plan.estimatedTargetRoiPct,\n      strategyLeverageCap: candidate.strategyLeverageCap,\n",
    "      estimatedTargetRoiPct: plan.estimatedTargetRoiPct,\n      actionableTier: plan.actionableTier ?? null,\n      expectancyReady: plan.expectancyEvidence?.ready ?? false,\n      expectancyResolvedCalls: plan.expectancyEvidence?.resolvedCalls ?? 0,\n      expectancyRequiredResolvedCalls: plan.expectancyEvidence?.requiredResolvedCalls ?? 0,\n      expectancyAverageR: plan.expectancyEvidence?.averageR ?? null,\n      expectancyProfitFactor: plan.expectancyEvidence?.profitFactor ?? null,\n      strategyLeverageCap: candidate.strategyLeverageCap,\n",
)

old_entry = r'''function entryText(call: PaperCall): string {
  return [
    `🚨 BTC ${call.direction.toUpperCase()} ALERT`,
    `${call.strategyName} · ${call.strategyVersion}`,
    `Entry: ${money(call.entryPrice)}`,
    `Leverage: ${call.leverage}x isolated paper`,
    `Margin: ${money(call.marginUsd)} · Notional: ${money(call.notionalUsd)}`,
    `Stop: ${money(call.stopPrice)}`,
    `Liquidation estimate: ${money(call.liquidationPrice)}`,
    `Target: ${money(call.targetPrice)}${call.extendedTargetPrice ? ` · Runner: ${money(call.extendedTargetPrice)}` : ''}`,
    `Projected target ROI: ${Number(call.features.estimatedTargetRoiPct || 0).toFixed(1)}%`,
    `Projected net R:R: ${Number(call.features.estimatedNetRR || 0).toFixed(2)}R`,
    `Confidence: ${call.confidence}`,
    `Paper only — no exchange order was placed.`,
  ].join('\n');
}
'''
new_entry = r'''function entryText(call: PaperCall): string {
  const tier = String(call.features.actionableTier || 'standard');
  const title = tier === 'a_plus'
    ? `🔥 BTC A+ ${call.direction.toUpperCase()} ALERT`
    : `🚨 BTC STANDARD ${call.direction.toUpperCase()} ALERT`;
  const resolved = Number(call.features.expectancyResolvedCalls || 0);
  const required = Number(call.features.expectancyRequiredResolvedCalls || 0);
  return [
    title,
    `${call.strategyName} · ${call.strategyVersion}`,
    `Entry: ${money(call.entryPrice)}`,
    `Leverage: ${call.leverage}x isolated paper`,
    `Margin: ${money(call.marginUsd)} · Notional: ${money(call.notionalUsd)}`,
    `Stop: ${money(call.stopPrice)}`,
    `Liquidation estimate: ${money(call.liquidationPrice)}`,
    `Target: ${money(call.targetPrice)}${call.extendedTargetPrice ? ` · Runner: ${money(call.extendedTargetPrice)}` : ''}`,
    `Projected target ROI: ${Number(call.features.estimatedTargetRoiPct || 0).toFixed(1)}%`,
    `Projected net R:R: ${Number(call.features.estimatedNetRR || 0).toFixed(2)}R`,
    `Research evidence: ${resolved}/${required} resolved · ${Number(call.features.expectancyAverageR || 0).toFixed(2)} avg R`,
    `Confidence: ${call.confidence}`,
    `Paper only — no exchange order was placed.`,
  ].join('\n');
}
'''
replace_exact('src/btc/platform/alerts.ts', old_entry, new_entry)

replace_exact(
    'src/btc/platform/ledger.ts',
    "    plan.estimatedTargetRoiPct, JSON.stringify(plan.costs),\n",
    "    plan.estimatedTargetRoiPct, JSON.stringify({\n      ...plan.costs,\n      actionableTier: plan.actionableTier ?? null,\n      expectancyEvidence: plan.expectancyEvidence ?? null,\n    }),\n",
)

replace_exact(
    'public/btc-dashboard.js',
    "    const book = call.book === 'actionable' ? 'ACTIONABLE ALERT' : 'STRATEGY RESEARCH';\n",
    "    const alertTier = String(call.features?.actionableTier || 'standard');\n    const book = call.book === 'actionable'\n      ? alertTier === 'a_plus' ? 'A+ ACTIONABLE ALERT' : 'STANDARD ACTIONABLE ALERT'\n      : 'STRATEGY RESEARCH';\n",
)
replace_exact(
    'public/btc-dashboard.js',
    "        <div class=\"metric\"><small>Confidence</small><b>${number(call.confidence, 0)}</b></div>\n",
    "        <div class=\"metric\"><small>Confidence</small><b>${number(call.confidence, 0)}</b></div>\n        <div class=\"metric\"><small>Projected policy</small><b>${call.book === 'actionable' ? escapeHtml(alertTier === 'a_plus' ? 'A+ PREMIUM' : 'STANDARD') : 'RESEARCH'} · ${number(call.features?.estimatedTargetRoiPct, 1)}% / ${number(call.features?.estimatedNetRR)}R</b></div>\n",
)
replace_exact(
    'public/btc-dashboard.js',
    "    const positive = Number(strategy.netPnlUsd) >= 0;\n    return `<article class=\"btcStrategyCard\">\n      <div class=\"callHead\"><span class=\"state ${strategy.mode === 'actionable' ? 'trigger' : 'watching'}\">${escapeHtml(String(strategy.mode || '').toUpperCase())}</span><small>CAP ${escapeHtml(strategy.leverageCap)}x</small></div>\n",
    "    const positive = Number(strategy.netPnlUsd) >= 0;\n    const profitFactorReady = strategy.profitFactor == null\n      ? Number(strategy.wins || 0) > 0 && Number(strategy.losses || 0) === 0\n      : Number(strategy.profitFactor) >= 1.1;\n    const evidenceReady = decided >= 30\n      && Number(strategy.netPnlUsd) > 0\n      && Number(strategy.averageR) >= 0.1\n      && profitFactorReady;\n    const modeLabel = strategy.mode === 'actionable'\n      ? evidenceReady ? 'ALERT READY' : `RESEARCH ${decided}/30`\n      : 'SHADOW';\n    return `<article class=\"btcStrategyCard\">\n      <div class=\"callHead\"><span class=\"state ${evidenceReady ? 'trigger' : 'watching'}\">${escapeHtml(modeLabel)}</span><small>CAP ${escapeHtml(strategy.leverageCap)}x</small></div>\n",
)
replace_exact(
    'public/btc-dashboard.js',
    "        <div class=\"metric\"><small>Profit factor</small><b>${strategy.profitFactor == null ? '—' : number(strategy.profitFactor)}</b></div>\n",
    "        <div class=\"metric\"><small>Profit factor</small><b>${strategy.profitFactor == null ? '—' : number(strategy.profitFactor)}</b></div>\n        <div class=\"metric\"><small>Actionable evidence</small><b>${strategy.mode === 'actionable' ? evidenceReady ? 'READY' : `${decided}/30` : 'SHADOW ONLY'}</b></div>\n",
)
replace_exact(
    'public/btc-dashboard.js',
    "        actionableMinimumNetTargetUsd: 20,\n        actionableMinimumNetRR: 3,\n",
    "        standardTargetPolicy: 'strategy_native_realistic_target',\n        standardMinimumProjectedNetRoiPct: 6,\n        standardMinimumNetRR: 2.25,\n        standardMaximumPlannedLossUsd: 6,\n        actionableExpectancyGate: {\n          minimumResolvedResearchCallsPerVersion: 30,\n          minimumAverageR: 0.10,\n          minimumProfitFactor: 1.10,\n          positiveNetPnlRequired: true,\n        },\n        aPlusMinimumProjectedNetRoiPct: 20,\n        aPlusMinimumNetRR: 3,\n        aPlusMinimumConfidence: 82,\n        aPlusMinimumExecutionScore: 80,\n        aPlusMaximumSpreadBps: 2,\n",
)

platform_test = r'''import assert from 'node:assert/strict';
import test from 'node:test';
import { solveRiskPlan } from './risk';
import { BTC_STRATEGIES } from './strategy-registry';
import { MarketContext, StrategyCandidate, StrategyPerformance } from './types';

const context: MarketContext = {
  timestamp: Date.now(),
  prices: {
    last: 100_000,
    bid: 99_999,
    ask: 100_001,
    mark: 100_000,
    index: 100_000,
    coinbaseSpot: 100_000,
    krakenSpot: 100_002,
    consolidatedFair: 100_001,
  },
  candles: { oneMinute: [], fiveMinute: [], fifteenMinute: [], oneHour: [], fourHour: [] },
  derivatives: {
    fundingRate: 0.00005,
    predictedFundingRate: 0.00005,
    nextFundingAt: Date.now() + 8 * 60 * 60_000,
    openInterest: 1_000,
    openInterestValue: 100_000_000,
    openInterestChangePct: 0.2,
    longLiquidationUsd5m: 0,
    shortLiquidationUsd5m: 0,
    basisBps: 0,
  },
  orderFlow: {
    aggressiveBuyUsd1m: 1_000_000,
    aggressiveSellUsd1m: 900_000,
    aggressiveBuyUsd5m: 5_000_000,
    aggressiveSellUsd5m: 4_500_000,
    topBookImbalance: 0.1,
    depthImbalance5Bps: 0.1,
    bookFragility: 0.05,
    absorptionScore: 0.5,
    bids: [{ price: 99_999, size: 20 }],
    asks: [{ price: 100_001, size: 20 }],
  },
  regime: {
    direction: 'bull', volatility: 'normal', liquidity: 'deep', positioning: 'neutral',
    event: 'normal', directionalScore: 40, volatilityPercentile: 50,
  },
  feed: {
    healthy: true,
    derivativesHealthy: true,
    referenceVenue: 'TEST-BTC-PERP',
    referenceAgeMs: 10,
    coinbaseAgeMs: 10,
    krakenAgeMs: 10,
    spreadBps: 0.2,
    markIndexBps: 0,
    crossVenueBps: 0.2,
    recentSequenceGap: false,
    blockers: [],
  },
};

function candidate(overrides: Partial<StrategyCandidate> = {}): StrategyCandidate {
  return {
    id: 'test-candidate',
    strategyId: 'test-strategy',
    strategyVersion: '1.0.0',
    strategyName: 'Test Strategy',
    mode: 'actionable',
    direction: 'long',
    setupType: 'test',
    createdAt: context.timestamp,
    entryMethod: 'retest',
    preferredEntry: 100_000,
    entryZoneLow: 99_990,
    entryZoneHigh: 100_010,
    doNotChasePrice: 100_050,
    expiresAt: context.timestamp + 60_000,
    structuralStop: 99_950,
    initialTarget: 100_600,
    extendedTarget: 101_000,
    maximumRealisticTarget: 102_000,
    minimumRR: 3,
    strategyLeverageCap: 50,
    expectedHoldingMinutes: 60,
    exitModel: 'partial_runner',
    scores: { signal: 90, regime: 90, execution: 90, data: 100 },
    invalidationReasons: [],
    rationale: ['test'],
    features: {},
    ...overrides,
  };
}

function evidence(overrides: Partial<StrategyPerformance> = {}): StrategyPerformance {
  return {
    strategyId: 'test-strategy',
    strategyVersion: '1.0.0',
    strategyName: 'Test Strategy',
    mode: 'actionable',
    leverageCap: 50,
    activeCalls: 0,
    totalCalls: 40,
    wins: 22,
    losses: 18,
    winRatePct: 55,
    netPnlUsd: 80,
    averageR: 0.25,
    profitFactor: 1.3,
    ...overrides,
  };
}

test('BTC strategy registry contains seventeen unique versioned strategies', () => {
  assert.equal(BTC_STRATEGIES.length, 17);
  assert.equal(new Set(BTC_STRATEGIES.map(strategy => strategy.id)).size, 17);
  assert.equal(BTC_STRATEGIES.filter(strategy => strategy.mode === 'actionable').length, 10);
  assert.equal(BTC_STRATEGIES.filter(strategy => strategy.mode === 'shadow').length, 7);
  for (const strategy of BTC_STRATEGIES) {
    assert.ok(strategy.version.length > 0);
    assert.ok(strategy.leverageCap >= 1 && strategy.leverageCap <= 50);
  }
});

test('standard actionable policy uses native target, 6% projected ROI, 2.25R and a $6 loss budget', () => {
  const plan = solveRiskPlan(context, candidate(), evidence());
  assert.equal(plan.approved, true, plan.rejectionReasons.join('; '));
  assert.equal(plan.targetPrice, 100_600);
  assert.equal(plan.actionableTier, 'standard');
  assert.ok(plan.leverage >= 1 && plan.leverage <= 50);
  assert.ok(plan.estimatedTargetRoiPct >= 6);
  assert.ok(plan.estimatedNetRR >= 2.25);
  assert.ok(plan.estimatedRiskUsd <= 6 + 1e-6);
  assert.ok(plan.liquidationBufferPct > 0);
  assert.equal(plan.expectancyEvidence?.ready, true);
});

test('A+ policy preserves the 20% projected ROI and 3R premium threshold', () => {
  const plan = solveRiskPlan(context, candidate({ initialTarget: 100_900 }), evidence());
  assert.equal(plan.approved, true, plan.rejectionReasons.join('; '));
  assert.equal(plan.actionableTier, 'a_plus');
  assert.ok(plan.estimatedTargetRoiPct >= 20);
  assert.ok(plan.estimatedNetRR >= 3);
});

test('actionable policy rejects an exact strategy version without mature positive expectancy', () => {
  const plan = solveRiskPlan(context, candidate(), evidence({
    totalCalls: 29,
    wins: 16,
    losses: 13,
    netPnlUsd: 20,
    averageR: 0.2,
    profitFactor: 1.2,
  }));
  assert.equal(plan.approved, false);
  assert.ok(plan.rejectionReasons.some(reason => reason.includes('30 resolved calls')));
});

test('actionable policy rejects negative demonstrated expectancy even with enough samples', () => {
  const plan = solveRiskPlan(context, candidate(), evidence({
    wins: 18,
    losses: 22,
    netPnlUsd: -5,
    averageR: -0.02,
    profitFactor: 0.95,
  }));
  assert.equal(plan.approved, false);
  assert.ok(plan.rejectionReasons.some(reason => reason.includes('net P&L is not positive')));
});

test('risk solver rejects an invalid structural stop beyond the maximum allowed setup distance', () => {
  const plan = solveRiskPlan(context, candidate({ structuralStop: 90_000, maximumRealisticTarget: 140_000 }), evidence());
  assert.equal(plan.approved, false);
  assert.ok(plan.rejectionReasons.some(reason => reason.includes('structural stop distance')));
});

test('strategy-specific leverage cap is enforced independently of the platform ceiling', () => {
  const plan = solveRiskPlan(context, candidate({ strategyLeverageCap: 12, initialTarget: 101_000 }), evidence());
  assert.equal(plan.approved, true, plan.rejectionReasons.join('; '));
  assert.ok(plan.leverage <= 12);
});
'''
Path('src/btc/platform/platform.test.ts').write_text(platform_test)

replace_exact(
    'src/btc/platform/research-risk.test.ts',
    "test('research can approve a native profitable target that the actionable +$20 and 3R contract rejects', () => {\n",
    "test('research can approve a native profitable target before actionable expectancy maturity', () => {\n",
)
replace_exact(
    'src/btc/platform/research-risk.test.ts',
    "  assert.ok(research.estimatedRiskUsd <= 20 / 3 + 1e-6);\n",
    "  assert.ok(research.estimatedRiskUsd <= 20 / 3 + 1e-6);\n  assert.ok(actionable.rejectionReasons.some(reason => reason.includes('expectancy')));\n",
)

print('BTC tiered actionable policy installed')
