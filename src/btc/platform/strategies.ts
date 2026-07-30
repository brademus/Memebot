import {
  BtcDirection,
  Candle,
  EntryMethod,
  ExitModel,
  MarketContext,
  StrategyCandidate,
  StrategyDefinition,
  StrategyMode,
} from './types';
import {
  averageTrueRange,
  clamp,
  compressionScore,
  directionalEfficiency,
  mean,
  median,
  pct,
  rangePosition,
  rollingVwap,
  safeDiv,
  standardDeviation,
  zScore,
} from './indicators';

interface CandidateInput {
  strategyId: string;
  strategyVersion: string;
  strategyName: string;
  mode: StrategyMode;
  direction: BtcDirection;
  setupType: string;
  entryMethod: EntryMethod;
  preferredEntry: number;
  entryZoneLow: number;
  entryZoneHigh: number;
  doNotChasePrice: number;
  expiresAt: number;
  structuralStop: number;
  initialTarget: number;
  extendedTarget: number | null;
  maximumRealisticTarget: number;
  minimumRR?: number;
  strategyLeverageCap: number;
  expectedHoldingMinutes: number;
  exitModel: ExitModel;
  signalScore: number;
  regimeScore: number;
  executionScore: number;
  dataScore?: number;
  rationale: string[];
  features: Record<string, number | string | boolean | null>;
}

const complete = (candles: Candle[]): Candle[] => candles.filter(candle => candle.complete);
const last = (candles: Candle[]): Candle | null => complete(candles).at(-1) || null;
const currentPrice = (context: MarketContext, direction: BtcDirection): number =>
  direction === 'long' ? context.prices.ask : context.prices.bid;

function candidate(context: MarketContext, input: CandidateInput): StrategyCandidate {
  const minuteBucket = Math.floor(context.timestamp / 60_000);
  return {
    id: `${input.strategyId}:${input.strategyVersion}:${input.direction}:${minuteBucket}`,
    strategyId: input.strategyId,
    strategyVersion: input.strategyVersion,
    strategyName: input.strategyName,
    mode: input.mode,
    direction: input.direction,
    setupType: input.setupType,
    createdAt: context.timestamp,
    entryMethod: input.entryMethod,
    preferredEntry: input.preferredEntry,
    entryZoneLow: Math.min(input.entryZoneLow, input.entryZoneHigh),
    entryZoneHigh: Math.max(input.entryZoneLow, input.entryZoneHigh),
    doNotChasePrice: input.doNotChasePrice,
    expiresAt: input.expiresAt,
    structuralStop: input.structuralStop,
    initialTarget: input.initialTarget,
    extendedTarget: input.extendedTarget,
    maximumRealisticTarget: input.maximumRealisticTarget,
    minimumRR: input.minimumRR ?? 3,
    strategyLeverageCap: input.strategyLeverageCap,
    expectedHoldingMinutes: input.expectedHoldingMinutes,
    exitModel: input.exitModel,
    scores: {
      signal: Math.round(clamp(input.signalScore, 0, 100)),
      regime: Math.round(clamp(input.regimeScore, 0, 100)),
      execution: Math.round(clamp(input.executionScore, 0, 100)),
      data: Math.round(clamp(input.dataScore ?? (context.feed.healthy ? 100 : 0), 0, 100)),
    },
    invalidationReasons: [],
    rationale: input.rationale,
    features: input.features,
  };
}

function targetFromRisk(entry: number, stop: number, direction: BtcDirection, multiple: number): number {
  const risk = Math.abs(entry - stop);
  return direction === 'long' ? entry + risk * multiple : entry - risk * multiple;
}

function directionAllowed(context: MarketContext, direction: BtcDirection): boolean {
  if (direction === 'long') return context.regime.direction === 'bull' || context.regime.direction === 'strong_bull';
  return context.regime.direction === 'bear' || context.regime.direction === 'strong_bear';
}

const momentumRetest: StrategyDefinition = {
  id: 'btc-momentum-retest',
  version: '3.0.0',
  name: 'Three-Stage Momentum Continuation',
  description: 'Waits for impulse, meaningful lower-volume pullback, structural reclaim, then a fresh stop trigger instead of buying the completed candle.',
  mode: 'actionable',
  leverageCap: 10,
  evaluate(context): StrategyCandidate[] {
    if (!context.feed.healthy || context.regime.volatility === 'compressed' || context.regime.volatility === 'extreme'
      || context.regime.liquidity === 'dislocated') return [];
    const candles = complete(context.candles.fifteenMinute);
    if (candles.length < 50) return [];
    const impulse = candles.at(-3)!;
    const pullback = candles.at(-2)!;
    const confirmation = candles.at(-1)!;
    const baseline = candles.slice(-35, -3);
    const atr = averageTrueRange(candles.slice(0, -2), 14);
    const range = impulse.high - impulse.low;
    if (!(atr > 0 && range > 0)) return [];
    const volumeRatio = safeDiv(impulse.volume, median(baseline.map(candle => candle.volume)), 0);
    const rangeRatio = safeDiv(range, atr, 0);
    const closeLocation = safeDiv(impulse.close - impulse.low, range, 0.5);
    const direction: BtcDirection | null = impulse.close > impulse.open && closeLocation >= 0.8 ? 'long'
      : impulse.close < impulse.open && closeLocation <= 0.2 ? 'short' : null;
    if (!direction || !directionAllowed(context, direction) || volumeRatio < 1.5 || rangeRatio < 1.25) return [];

    const retracement = direction === 'long'
      ? safeDiv(impulse.high - pullback.low, range, 0)
      : safeDiv(pullback.high - impulse.low, range, 0);
    const pullbackVolumeRatio = safeDiv(pullback.volume, impulse.volume, 1);
    if (retracement < 0.35 || retracement > 0.68 || pullbackVolumeRatio > 0.82) return [];
    const confirmationValid = direction === 'long'
      ? confirmation.close > pullback.high && confirmation.close > confirmation.open
      : confirmation.close < pullback.low && confirmation.close < confirmation.open;
    if (!confirmationValid) return [];

    const flow = direction === 'long'
      ? safeDiv(context.orderFlow.aggressiveBuyUsd5m, context.orderFlow.aggressiveSellUsd5m, 0)
      : safeDiv(context.orderFlow.aggressiveSellUsd5m, context.orderFlow.aggressiveBuyUsd5m, 0);
    if (flow < 1.15) return [];
    const preImpulsePosition = rangePosition(candles.slice(0, -3), 32, impulse.open);
    if ((direction === 'long' && preImpulsePosition > 0.9) || (direction === 'short' && preImpulsePosition < 0.1)) return [];

    const entry = direction === 'long' ? confirmation.high + atr * 0.04 : confirmation.low - atr * 0.04;
    const stop = direction === 'long'
      ? Math.min(impulse.low, pullback.low) - atr * 0.18
      : Math.max(impulse.high, pullback.high) + atr * 0.18;
    const initialTarget = targetFromRisk(entry, stop, direction, 3.4);
    const extended = targetFromRisk(entry, stop, direction, 5.2);
    return [candidate(context, {
      strategyId: this.id, strategyVersion: this.version, strategyName: this.name, mode: this.mode,
      direction, setupType: 'impulse_pullback_reclaim_trigger', entryMethod: 'stop', preferredEntry: entry,
      entryZoneLow: entry - atr * 0.02, entryZoneHigh: entry + atr * 0.02,
      doNotChasePrice: direction === 'long' ? entry + atr * 0.25 : entry - atr * 0.25,
      expiresAt: context.timestamp + 25 * 60_000, structuralStop: stop, initialTarget,
      extendedTarget: extended, maximumRealisticTarget: direction === 'long' ? entry + atr * 12 : entry - atr * 12,
      strategyLeverageCap: this.leverageCap, expectedHoldingMinutes: 240, exitModel: 'partial_runner',
      signalScore: 68 + (volumeRatio - 1.5) * 12 + (rangeRatio - 1.25) * 10 + Math.max(0, flow - 1.15) * 10,
      regimeScore: 74 + Math.abs(context.regime.directionalScore) * 0.2,
      executionScore: 92 - (context.feed.spreadBps || 0) * 3 - context.orderFlow.bookFragility * 30,
      rationale: [
        `${direction} impulse completed before a ${retracement.toFixed(2)} retracement`,
        `pullback volume was ${pullbackVolumeRatio.toFixed(2)} of impulse volume`,
        'separate reclaim candle completed; next continuation break is required',
        `directional five-minute flow ratio ${flow.toFixed(2)}`,
      ],
      features: { volumeRatio, rangeRatio, closeLocation, retracement, pullbackVolumeRatio, flowRatio: flow,
        atr, preImpulsePosition, triggerPrice: entry },
    })];
  },
};

const compressionBreakout: StrategyDefinition = {
  id: 'btc-compression-breakout',
  version: '2.0.0',
  name: 'Retest-Triggered Compression Breakout',
  description: 'Requires pre-break compression, bounded acceptance, an actual boundary retest, and a new stop trigger after the retest.',
  mode: 'actionable',
  leverageCap: 10,
  evaluate(context): StrategyCandidate[] {
    if (!context.feed.healthy || context.regime.liquidity === 'dislocated' || context.regime.volatility === 'extreme') return [];
    const candles = complete(context.candles.fiveMinute);
    if (candles.length < 55) return [];
    const breakout = candles.at(-2)!;
    const retest = candles.at(-1)!;
    const prior = candles.slice(-42, -2);
    const boundarySample = prior.slice(-24);
    const rangeHigh = Math.max(...boundarySample.map(candle => candle.high));
    const rangeLow = Math.min(...boundarySample.map(candle => candle.low));
    const range = rangeHigh - rangeLow;
    const atr = averageTrueRange(candles.slice(0, -1), 14);
    const compression = compressionScore(candles.slice(0, -2));
    const volumeRatio = safeDiv(breakout.volume, median(prior.slice(-32).map(candle => candle.volume)), 0);
    if (!(range > 0 && atr > 0) || range < atr * 1.8) return [];
    const direction: BtcDirection | null = breakout.close > rangeHigh && breakout.open <= rangeHigh ? 'long'
      : breakout.close < rangeLow && breakout.open >= rangeLow ? 'short' : null;
    if (!direction || compression < 0.72 || volumeRatio < 1.7) return [];
    if ((direction === 'long' && context.regime.direction === 'strong_bear')
      || (direction === 'short' && context.regime.direction === 'strong_bull')) return [];

    const acceptance = direction === 'long'
      ? safeDiv(breakout.close - rangeHigh, range, 0)
      : safeDiv(rangeLow - breakout.close, range, 0);
    if (acceptance < 0.06 || acceptance > 0.35) return [];
    const touchedAndHeld = direction === 'long'
      ? retest.low <= rangeHigh + range * 0.03 && retest.low >= rangeHigh - range * 0.15
        && retest.close > rangeHigh && retest.close > retest.open
      : retest.high >= rangeLow - range * 0.03 && retest.high <= rangeLow + range * 0.15
        && retest.close < rangeLow && retest.close < retest.open;
    if (!touchedAndHeld) return [];
    const alignedDepth = direction === 'long' ? context.orderFlow.depthImbalance5Bps : -context.orderFlow.depthImbalance5Bps;
    const flow = direction === 'long'
      ? safeDiv(context.orderFlow.aggressiveBuyUsd5m, context.orderFlow.aggressiveSellUsd5m, 0)
      : safeDiv(context.orderFlow.aggressiveSellUsd5m, context.orderFlow.aggressiveBuyUsd5m, 0);
    if (alignedDepth < 0.05 || flow < 1.1) return [];

    const entry = direction === 'long' ? retest.high + atr * 0.03 : retest.low - atr * 0.03;
    const stop = direction === 'long'
      ? Math.min(rangeHigh - range * 0.2, retest.low - atr * 0.08)
      : Math.max(rangeLow + range * 0.2, retest.high + atr * 0.08);
    const initialTarget = targetFromRisk(entry, stop, direction, 3.5);
    const extended = targetFromRisk(entry, stop, direction, 5.5);
    return [candidate(context, {
      strategyId: this.id, strategyVersion: this.version, strategyName: this.name, mode: this.mode,
      direction, setupType: 'compression_break_retest_trigger', entryMethod: 'stop', preferredEntry: entry,
      entryZoneLow: entry - atr * 0.02, entryZoneHigh: entry + atr * 0.02,
      doNotChasePrice: direction === 'long' ? entry + atr * 0.22 : entry - atr * 0.22,
      expiresAt: context.timestamp + 20 * 60_000, structuralStop: stop, initialTarget,
      extendedTarget: extended, maximumRealisticTarget: direction === 'long' ? entry + range * 3.2 : entry - range * 3.2,
      strategyLeverageCap: this.leverageCap, expectedHoldingMinutes: 180, exitModel: 'partial_runner',
      signalScore: 70 + compression * 12 + (volumeRatio - 1.7) * 12 + alignedDepth * 10 + Math.max(0, flow - 1.1) * 8,
      regimeScore: context.regime.volatility === 'compressed' ? 94 : 80,
      executionScore: 92 - (context.feed.spreadBps || 0) * 3 - context.orderFlow.bookFragility * 28,
      rationale: [
        `pre-break compression score ${compression.toFixed(2)}`,
        `${direction} breakout accepted ${(acceptance * 100).toFixed(1)}% beyond the range`,
        'completed candle touched and held the broken boundary',
        'a new continuation break is required before entry',
      ],
      features: { compression, volumeRatio, acceptance, rangeHigh, rangeLow, alignedDepth, flowRatio: flow,
        atr, triggerPrice: entry, retestClose: retest.close },
    })];
  },
};

const liquiditySweep: StrategyDefinition = {
  id: 'btc-liquidity-sweep-reversal',
  version: '1.0.0',
  name: 'Liquidity Sweep Reversal',
  description: 'Detects failed breaks of established liquidity with reclaim, absorption and short-term structure reversal.',
  mode: 'actionable',
  leverageCap: 30,
  evaluate(context): StrategyCandidate[] {
    if (!context.feed.healthy || context.regime.event === 'liquidation_cascade') return [];
    const candles = complete(context.candles.fiveMinute);
    if (candles.length < 30) return [];
    const current = candles.at(-1)!;
    const prior = candles.slice(-14, -1);
    const priorLow = Math.min(...prior.map(candle => candle.low));
    const priorHigh = Math.max(...prior.map(candle => candle.high));
    const atr = averageTrueRange(candles, 14);
    const longSweep = current.low < priorLow - atr * 0.05 && current.close > priorLow && current.close > current.open;
    const shortSweep = current.high > priorHigh + atr * 0.05 && current.close < priorHigh && current.close < current.open;
    const direction: BtcDirection | null = longSweep ? 'long' : shortSweep ? 'short' : null;
    if (!direction) return [];
    const flowRatio = direction === 'long'
      ? safeDiv(context.orderFlow.aggressiveSellUsd1m, context.orderFlow.aggressiveBuyUsd1m, 0)
      : safeDiv(context.orderFlow.aggressiveBuyUsd1m, context.orderFlow.aggressiveSellUsd1m, 0);
    const absorption = context.orderFlow.absorptionScore;
    if (absorption < 0.35 && flowRatio < 1.2) return [];
    const reclaimed = direction === 'long' ? priorLow : priorHigh;
    const stop = direction === 'long' ? current.low - atr * 0.08 : current.high + atr * 0.08;
    const entry = reclaimed;
    const initialTarget = targetFromRisk(entry, stop, direction, 3.25);
    const opposite = direction === 'long' ? priorHigh : priorLow;
    return [candidate(context, {
      strategyId: this.id, strategyVersion: this.version, strategyName: this.name, mode: this.mode,
      direction, setupType: 'failed_break_reclaim', entryMethod: 'retest', preferredEntry: entry,
      entryZoneLow: direction === 'long' ? reclaimed - atr * 0.08 : reclaimed - atr * 0.04,
      entryZoneHigh: direction === 'long' ? reclaimed + atr * 0.04 : reclaimed + atr * 0.08,
      doNotChasePrice: direction === 'long' ? reclaimed + atr * 0.7 : reclaimed - atr * 0.7,
      expiresAt: context.timestamp + 35 * 60_000, structuralStop: stop, initialTarget,
      extendedTarget: opposite, maximumRealisticTarget: direction === 'long' ? Math.max(opposite, initialTarget) : Math.min(opposite, initialTarget),
      strategyLeverageCap: this.leverageCap, expectedHoldingMinutes: 120, exitModel: 'partial_runner',
      signalScore: 60 + absorption * 22 + Math.min(15, Math.max(0, flowRatio - 1) * 12),
      regimeScore: context.regime.direction === 'range' ? 90 : 68,
      executionScore: 88 - context.orderFlow.bookFragility * 25 - (context.feed.spreadBps || 0) * 3,
      rationale: [
        `${direction} sweep beyond established ${prior.length}-bar liquidity`,
        `price reclaimed the swept boundary`,
        `absorption score ${absorption.toFixed(2)}`,
      ],
      features: { priorLow, priorHigh, atr, flowRatio, absorption, sweepExtreme: direction === 'long' ? current.low : current.high },
    })];
  },
};

const vwapMeanReversion: StrategyDefinition = {
  id: 'btc-vwap-mean-reversion',
  version: '1.0.0',
  name: 'Regime-Gated VWAP Mean Reversion',
  description: 'Fades statistically stretched range edges only while directional efficiency and derivatives pressure remain subdued.',
  mode: 'actionable',
  leverageCap: 20,
  evaluate(context): StrategyCandidate[] {
    if (!context.feed.healthy || context.regime.direction !== 'range' || context.regime.event !== 'normal') return [];
    const candles = complete(context.candles.fiveMinute);
    if (candles.length < 60) return [];
    const price = context.prices.mark;
    const vwap = rollingVwap(candles, 48);
    const deviations = candles.slice(-60).map(candle => ((candle.close / Math.max(vwap, 1)) - 1) * 100);
    const deviationPct = ((price / Math.max(vwap, 1)) - 1) * 100;
    const deviationZ = zScore(deviations, deviationPct);
    const position = rangePosition(candles, 48, price);
    const efficiency = directionalEfficiency(candles, 36);
    if (efficiency > 0.38) return [];
    const latest = candles.at(-1)!;
    const direction: BtcDirection | null = deviationZ <= -1.6 && position <= 0.18 && latest.close > latest.open ? 'long'
      : deviationZ >= 1.6 && position >= 0.82 && latest.close < latest.open ? 'short' : null;
    if (!direction) return [];
    const atr = averageTrueRange(candles, 14);
    const entry = currentPrice(context, direction);
    const stop = direction === 'long' ? latest.low - atr * 0.2 : latest.high + atr * 0.2;
    const threeR = targetFromRisk(entry, stop, direction, 3.1);
    const initialTarget = direction === 'long' ? Math.min(vwap, Math.max(threeR, entry)) : Math.max(vwap, Math.min(threeR, entry));
    const maximum = direction === 'long' ? Math.max(vwap + atr * 1.5, threeR) : Math.min(vwap - atr * 1.5, threeR);
    if ((direction === 'long' && initialTarget <= entry) || (direction === 'short' && initialTarget >= entry)) return [];
    return [candidate(context, {
      strategyId: this.id, strategyVersion: this.version, strategyName: this.name, mode: this.mode,
      direction, setupType: 'range_edge_reentry', entryMethod: 'market', preferredEntry: entry,
      entryZoneLow: direction === 'long' ? entry - atr * 0.1 : entry - atr * 0.05,
      entryZoneHigh: direction === 'long' ? entry + atr * 0.05 : entry + atr * 0.1,
      doNotChasePrice: direction === 'long' ? entry + atr * 0.35 : entry - atr * 0.35,
      expiresAt: context.timestamp + 20 * 60_000, structuralStop: stop, initialTarget,
      extendedTarget: vwap, maximumRealisticTarget: maximum, strategyLeverageCap: this.leverageCap,
      expectedHoldingMinutes: 90, exitModel: 'fixed',
      signalScore: 58 + Math.min(22, Math.abs(deviationZ) * 7) + (0.38 - efficiency) * 35,
      regimeScore: 92,
      executionScore: 90 - (context.feed.spreadBps || 0) * 4 - context.orderFlow.bookFragility * 20,
      rationale: [
        `range regime with directional efficiency ${efficiency.toFixed(2)}`,
        `VWAP deviation z-score ${deviationZ.toFixed(2)}`,
        `price at ${(position * 100).toFixed(0)}% of the active range`,
      ],
      features: { vwap, deviationPct, deviationZ, rangePosition: position, efficiency, atr },
    })];
  },
};

const derivativesSqueeze: StrategyDefinition = {
  id: 'btc-derivatives-squeeze',
  version: '1.0.0',
  name: 'Funding/OI Liquidation Squeeze',
  description: 'Uses funding, basis, open interest and liquidation pressure to trade crowded reversals or controlled cascade continuation.',
  mode: 'actionable',
  leverageCap: 25,
  evaluate(context): StrategyCandidate[] {
    if (!context.feed.healthy || !context.feed.derivativesHealthy) return [];
    const latest = last(context.candles.fiveMinute);
    if (!latest) return [];
    const atr = averageTrueRange(context.candles.fiveMinute, 14);
    const funding = context.derivatives.fundingRate;
    const oiChange = context.derivatives.openInterestChangePct;
    const longLiq = context.derivatives.longLiquidationUsd5m;
    const shortLiq = context.derivatives.shortLiquidationUsd5m;
    const basis = context.derivatives.basisBps;
    const flow = safeDiv(context.orderFlow.aggressiveBuyUsd5m, context.orderFlow.aggressiveSellUsd5m, 1);

    let direction: BtcDirection | null = null;
    let setupType = '';
    if (funding > 0.00045 && oiChange > 0.4 && basis > 4 && latest.close < latest.open && flow < 0.9) {
      direction = 'short'; setupType = 'crowded_long_reversal';
    } else if (funding < -0.00045 && oiChange > 0.4 && basis < -4 && latest.close > latest.open && flow > 1.1) {
      direction = 'long'; setupType = 'crowded_short_reversal';
    } else if (longLiq > 2_500_000 && oiChange < -0.8 && latest.close < latest.open && flow < 0.75) {
      direction = 'short'; setupType = 'long_liquidation_continuation';
    } else if (shortLiq > 2_500_000 && oiChange < -0.8 && latest.close > latest.open && flow > 1.3) {
      direction = 'long'; setupType = 'short_liquidation_continuation';
    }
    if (!direction) return [];
    const entry = currentPrice(context, direction);
    const stop = direction === 'long' ? latest.low - atr * 0.3 : latest.high + atr * 0.3;
    const initialTarget = targetFromRisk(entry, stop, direction, 3.4);
    const extended = targetFromRisk(entry, stop, direction, 5.5);
    const liquidationPressure = direction === 'long' ? shortLiq : longLiq;
    return [candidate(context, {
      strategyId: this.id, strategyVersion: this.version, strategyName: this.name, mode: this.mode,
      direction, setupType, entryMethod: 'retest', preferredEntry: entry,
      entryZoneLow: direction === 'long' ? entry - atr * 0.18 : entry - atr * 0.06,
      entryZoneHigh: direction === 'long' ? entry + atr * 0.06 : entry + atr * 0.18,
      doNotChasePrice: direction === 'long' ? entry + atr * 0.5 : entry - atr * 0.5,
      expiresAt: context.timestamp + 25 * 60_000, structuralStop: stop, initialTarget,
      extendedTarget: extended, maximumRealisticTarget: direction === 'long' ? entry + atr * 7 : entry - atr * 7,
      strategyLeverageCap: this.leverageCap, expectedHoldingMinutes: 180, exitModel: 'partial_runner',
      signalScore: 60 + Math.min(15, Math.abs(funding) * 15_000) + Math.min(15, liquidationPressure / 1_000_000),
      regimeScore: context.regime.positioning === 'neutral' ? 68 : 92,
      executionScore: 82 - context.orderFlow.bookFragility * 30 - (context.feed.spreadBps || 0) * 4,
      rationale: [
        setupType.replaceAll('_', ' '),
        `funding ${(funding * 100).toFixed(4)}%`,
        `open interest change ${oiChange.toFixed(2)}%`,
        `five-minute liquidation pressure $${Math.round(liquidationPressure).toLocaleString()}`,
      ],
      features: { funding, oiChange, basis, longLiq, shortLiq, flow, atr },
    })];
  },
};

const orderFlowAbsorption: StrategyDefinition = {
  id: 'btc-orderflow-absorption',
  version: '0.4.0-shadow',
  name: 'Trapped-Aggressor Absorption Reversal',
  description: 'Treats heavy aggressive flow that fails to move price as trapped pressure and enters only after price breaks the opposite way.',
  mode: 'shadow',
  leverageCap: 8,
  evaluate(context): StrategyCandidate[] {
    if (!context.feed.healthy || !context.feed.derivativesHealthy
      || !['deep', 'normal'].includes(context.regime.liquidity)
      || context.regime.event !== 'normal' || context.orderFlow.bookFragility > 0.2
      || Math.abs(context.regime.directionalScore) > 35) return [];
    const buyAbsorption = context.orderFlow.buyAbsorptionScore ?? 0;
    const sellAbsorption = context.orderFlow.sellAbsorptionScore ?? 0;
    const depth = context.orderFlow.depthImbalance5Bps;
    const totalFlow = context.orderFlow.aggressiveBuyUsd1m + context.orderFlow.aggressiveSellUsd1m;
    if (totalFlow < 500_000) return [];
    let direction: BtcDirection | null = null;
    if (buyAbsorption >= 0.65 && depth <= -0.15) direction = 'short';
    if (sellAbsorption >= 0.65 && depth >= 0.15) direction = 'long';
    if (!direction) return [];

    const candles = complete(context.candles.oneMinute);
    const latest = candles.at(-1);
    const previous = candles.at(-2);
    if (!latest || !previous) return [];
    const atr = averageTrueRange(candles, 20);
    if (!(atr > 0)) return [];
    const reversalBreak = direction === 'long'
      ? latest.close > previous.high && latest.close > latest.open
      : latest.close < previous.low && latest.close < latest.open;
    if (!reversalBreak) return [];

    const entry = direction === 'long' ? latest.high + atr * 0.04 : latest.low - atr * 0.04;
    const stop = direction === 'long'
      ? Math.min(previous.low, latest.low) - atr * 0.22
      : Math.max(previous.high, latest.high) + atr * 0.22;
    const initialTarget = targetFromRisk(entry, stop, direction, 3.6);
    return [candidate(context, {
      strategyId: this.id, strategyVersion: this.version, strategyName: this.name, mode: this.mode,
      direction, setupType: 'trapped_aggressor_reversal_trigger', entryMethod: 'stop', preferredEntry: entry,
      entryZoneLow: entry - atr * 0.02, entryZoneHigh: entry + atr * 0.02,
      doNotChasePrice: direction === 'long' ? entry + atr * 0.2 : entry - atr * 0.2,
      expiresAt: context.timestamp + 5 * 60_000, structuralStop: stop, initialTarget,
      extendedTarget: targetFromRisk(entry, stop, direction, 5.5),
      maximumRealisticTarget: direction === 'long' ? entry + atr * 12 : entry - atr * 12,
      strategyLeverageCap: this.leverageCap, expectedHoldingMinutes: 45, exitModel: 'partial_runner',
      signalScore: 72 + Math.max(buyAbsorption, sellAbsorption) * 18 + Math.abs(depth) * 10,
      regimeScore: context.regime.direction === 'range' ? 94 : 80,
      executionScore: 96 - context.orderFlow.bookFragility * 55 - (context.feed.spreadBps || 0) * 5,
      rationale: [
        `${direction === 'short' ? 'buy' : 'sell'} aggressors failed to produce directional price progress`,
        `directional absorption score ${Math.max(buyAbsorption, sellAbsorption).toFixed(2)}`,
        `opposing depth imbalance ${depth.toFixed(2)}`,
        'price broke opposite the trapped aggressive side; a fresh trigger is still required',
      ],
      features: { buyAbsorption, sellAbsorption, depth, totalFlow, signedMovePct1m: context.orderFlow.signedMovePct1m ?? 0,
        atr, triggerPrice: entry },
    })];
  },
};

const crossVenueLag: StrategyDefinition = {
  id: 'btc-cross-venue-lag',
  version: '0.1.0-shadow',
  name: 'Cross-Venue Price-Discovery Lag',
  description: 'Shadow-only convergence model for temporary reference-perpetual dislocations versus consolidated spot fair value.',
  mode: 'shadow',
  leverageCap: 50,
  evaluate(context): StrategyCandidate[] {
    if (!context.feed.healthy || !context.feed.derivativesHealthy || context.regime.liquidity === 'dislocated') return [];
    const fair = context.prices.consolidatedFair;
    const mark = context.prices.mark;
    const divergenceBps = safeDiv(mark - fair, fair) * 10_000;
    if (Math.abs(divergenceBps) < 7 || Math.abs(divergenceBps) > 40) return [];
    const direction: BtcDirection = divergenceBps < 0 ? 'long' : 'short';
    const entry = currentPrice(context, direction);
    const noise = Math.max(entry * 0.00035, Math.abs(mark - fair) * 0.45);
    const stop = direction === 'long' ? entry - noise : entry + noise;
    const convergenceTarget = fair;
    const threeR = targetFromRisk(entry, stop, direction, 3.05);
    const initialTarget = direction === 'long' ? Math.min(fair, Math.max(threeR, entry)) : Math.max(fair, Math.min(threeR, entry));
    if ((direction === 'long' && initialTarget <= entry) || (direction === 'short' && initialTarget >= entry)) return [];
    return [candidate(context, {
      strategyId: this.id, strategyVersion: this.version, strategyName: this.name, mode: this.mode,
      direction, setupType: 'reference_perp_convergence', entryMethod: 'market', preferredEntry: entry,
      entryZoneLow: direction === 'long' ? entry - noise * 0.15 : entry - noise * 0.05,
      entryZoneHigh: direction === 'long' ? entry + noise * 0.05 : entry + noise * 0.15,
      doNotChasePrice: direction === 'long' ? entry + noise * 0.4 : entry - noise * 0.4,
      expiresAt: context.timestamp + 90_000, structuralStop: stop, initialTarget,
      extendedTarget: convergenceTarget, maximumRealisticTarget: convergenceTarget,
      strategyLeverageCap: this.leverageCap, expectedHoldingMinutes: 8, exitModel: 'fixed',
      signalScore: 55 + Math.min(30, Math.abs(divergenceBps) * 1.2),
      regimeScore: 75,
      executionScore: 85 - (context.feed.spreadBps || 0) * 8 - context.orderFlow.bookFragility * 35,
      rationale: [
        `reference perpetual is ${divergenceBps.toFixed(1)} bps from consolidated spot fair value`,
        'convergence target remains beyond net 3R',
        'shadow-only until end-to-end notification latency is measured',
      ],
      features: { fair, mark, divergenceBps, noise },
    })];
  },
};

export const BTC_STRATEGIES: readonly StrategyDefinition[] = Object.freeze([
  momentumRetest,
  compressionBreakout,
  liquiditySweep,
  vwapMeanReversion,
  derivativesSqueeze,
  orderFlowAbsorption,
  crossVenueLag,
]);

export function strategyById(id: string): StrategyDefinition | undefined {
  return BTC_STRATEGIES.find(strategy => strategy.id === id);
}
