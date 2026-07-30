from pathlib import Path
import re


def replace_once(path: str, pattern: str, replacement: str) -> None:
    file = Path(path)
    text = file.read_text()
    updated, count = re.subn(pattern, replacement, text, count=1, flags=re.S)
    if count != 1:
        raise RuntimeError(f"expected one replacement in {path}, got {count}")
    file.write_text(updated)


momentum = r'''const momentumRetest: StrategyDefinition = {
  id: 'btc-momentum-retest',
  version: '2.1.0',
  name: 'Confirmed Momentum Retest',
  description: 'Requires a completed high-volume impulse, a separate controlled pullback candle, directional reclaim and live flow confirmation.',
  mode: 'actionable',
  leverageCap: 18,
  evaluate(context): StrategyCandidate[] {
    if (!context.feed.healthy || context.regime.volatility === 'compressed' || context.regime.volatility === 'extreme'
      || context.regime.liquidity === 'dislocated') return [];
    const candles = complete(context.candles.fifteenMinute);
    if (candles.length < 36) return [];
    const impulse = candles.at(-2)!;
    const retest = candles.at(-1)!;
    const baseline = candles.slice(-34, -2);
    const volumeRatio = safeDiv(impulse.volume, median(baseline.map(candle => candle.volume)), 0);
    const atr = averageTrueRange(candles.slice(0, -1), 14);
    const range = impulse.high - impulse.low;
    const rangeRatio = safeDiv(range, atr, 0);
    const closeLocation = safeDiv(impulse.close - impulse.low, range, 0.5);
    const direction: BtcDirection | null = impulse.close > impulse.open && closeLocation >= 0.78 ? 'long'
      : impulse.close < impulse.open && closeLocation <= 0.22 ? 'short' : null;
    if (!direction || !directionAllowed(context, direction) || volumeRatio < 1.6 || rangeRatio < 1.35 || !(atr > 0)) return [];

    const flow = direction === 'long'
      ? safeDiv(context.orderFlow.aggressiveBuyUsd5m, context.orderFlow.aggressiveSellUsd5m, 0)
      : safeDiv(context.orderFlow.aggressiveSellUsd5m, context.orderFlow.aggressiveBuyUsd5m, 0);
    if (flow < 1.25) return [];
    const touched = direction === 'long'
      ? retest.low <= impulse.low + range * 0.62 && retest.low >= impulse.low - atr * 0.2
      : retest.high >= impulse.high - range * 0.62 && retest.high <= impulse.high + atr * 0.2;
    const reclaimed = direction === 'long'
      ? retest.close >= impulse.low + range * 0.58 && retest.close > retest.open && retest.close > impulse.open
      : retest.close <= impulse.high - range * 0.58 && retest.close < retest.open && retest.close < impulse.open;
    if (!touched || !reclaimed) return [];

    const entry = currentPrice(context, direction);
    const stop = direction === 'long'
      ? Math.min(impulse.low, retest.low) - atr * 0.22
      : Math.max(impulse.high, retest.high) + atr * 0.22;
    const initialTarget = targetFromRisk(entry, stop, direction, 3.8);
    const extended = targetFromRisk(entry, stop, direction, 5.5);
    const signalScore = 64 + (volumeRatio - 1.6) * 14 + (rangeRatio - 1.35) * 12 + Math.max(0, flow - 1.25) * 12;
    const regimeScore = 70 + Math.abs(context.regime.directionalScore) * 0.25;
    const executionScore = 92 - (context.feed.spreadBps || 0) * 3 - context.orderFlow.bookFragility * 30;
    return [candidate(context, {
      strategyId: this.id, strategyVersion: this.version, strategyName: this.name, mode: this.mode,
      direction, setupType: 'confirmed_impulse_retest', entryMethod: 'retest', preferredEntry: entry,
      entryZoneLow: entry - atr * 0.1,
      entryZoneHigh: entry + atr * 0.1,
      doNotChasePrice: direction === 'long' ? entry + atr * 0.35 : entry - atr * 0.35,
      expiresAt: context.timestamp + 12 * 60_000, structuralStop: stop, initialTarget,
      extendedTarget: extended, maximumRealisticTarget: direction === 'long' ? entry + atr * 10 : entry - atr * 10,
      strategyLeverageCap: this.leverageCap, expectedHoldingMinutes: 240, exitModel: 'partial_runner',
      signalScore, regimeScore, executionScore,
      rationale: [
        `${direction} higher-timeframe regime`,
        `completed 15m impulse volume ${volumeRatio.toFixed(2)}x baseline`,
        `separate retest candle reclaimed directional structure`,
        `directional five-minute flow ratio ${flow.toFixed(2)}`,
      ],
      features: { volumeRatio, rangeRatio, closeLocation, flowRatio: flow, atr, directionalScore: context.regime.directionalScore,
        retestLow: retest.low, retestHigh: retest.high, retestClose: retest.close },
    })];
  },
};'''

compression = r'''const compressionBreakout: StrategyDefinition = {
  id: 'btc-compression-breakout',
  version: '1.1.0',
  name: 'Confirmed Compression Breakout',
  description: 'Requires mature compression, a high-participation breakout and a second candle that retests and holds the range boundary.',
  mode: 'actionable',
  leverageCap: 20,
  evaluate(context): StrategyCandidate[] {
    if (!context.feed.healthy || context.regime.liquidity === 'dislocated' || context.regime.volatility === 'extreme') return [];
    const candles = complete(context.candles.fiveMinute);
    if (candles.length < 52) return [];
    const breakout = candles.at(-2)!;
    const confirmation = candles.at(-1)!;
    const prior = candles.slice(-39, -2);
    const boundarySample = prior.slice(-24);
    const rangeHigh = Math.max(...boundarySample.map(candle => candle.high));
    const rangeLow = Math.min(...boundarySample.map(candle => candle.low));
    const range = rangeHigh - rangeLow;
    const compression = compressionScore(candles.slice(0, -2));
    const volumeRatio = safeDiv(breakout.volume, median(prior.slice(-32).map(candle => candle.volume)), 0);
    const direction: BtcDirection | null = breakout.close > rangeHigh && breakout.open <= rangeHigh ? 'long'
      : breakout.close < rangeLow && breakout.open >= rangeLow ? 'short' : null;
    if (!direction || compression < 0.7 || volumeRatio < 1.5 || !(range > 0)) return [];
    if ((direction === 'long' && context.regime.direction === 'strong_bear')
      || (direction === 'short' && context.regime.direction === 'strong_bull')) return [];

    const acceptance = direction === 'long'
      ? safeDiv(breakout.close - rangeHigh, range, 0)
      : safeDiv(rangeLow - breakout.close, range, 0);
    const held = direction === 'long'
      ? confirmation.low <= rangeHigh + range * 0.1 && confirmation.close >= rangeHigh + range * 0.03
        && confirmation.close > confirmation.open
      : confirmation.high >= rangeLow - range * 0.1 && confirmation.close <= rangeLow - range * 0.03
        && confirmation.close < confirmation.open;
    const alignedDepth = direction === 'long' ? context.orderFlow.depthImbalance5Bps : -context.orderFlow.depthImbalance5Bps;
    const flow = direction === 'long'
      ? safeDiv(context.orderFlow.aggressiveBuyUsd5m, context.orderFlow.aggressiveSellUsd5m, 0)
      : safeDiv(context.orderFlow.aggressiveSellUsd5m, context.orderFlow.aggressiveBuyUsd5m, 0);
    if (acceptance < 0.08 || !held || alignedDepth < 0.15 || flow < 1.2) return [];

    const entry = currentPrice(context, direction);
    const stop = direction === 'long'
      ? Math.min(rangeHigh - range * 0.22, confirmation.low - range * 0.04)
      : Math.max(rangeLow + range * 0.22, confirmation.high + range * 0.04);
    const initialTarget = targetFromRisk(entry, stop, direction, 4);
    const extended = targetFromRisk(entry, stop, direction, 6);
    return [candidate(context, {
      strategyId: this.id, strategyVersion: this.version, strategyName: this.name, mode: this.mode,
      direction, setupType: 'confirmed_compression_acceptance', entryMethod: 'retest', preferredEntry: entry,
      entryZoneLow: entry - range * 0.04,
      entryZoneHigh: entry + range * 0.04,
      doNotChasePrice: direction === 'long' ? entry + range * 0.18 : entry - range * 0.18,
      expiresAt: context.timestamp + 15 * 60_000, structuralStop: stop, initialTarget,
      extendedTarget: extended, maximumRealisticTarget: direction === 'long' ? entry + range * 2.8 : entry - range * 2.8,
      strategyLeverageCap: this.leverageCap, expectedHoldingMinutes: 180, exitModel: 'partial_runner',
      signalScore: 66 + compression * 15 + (volumeRatio - 1.5) * 14 + alignedDepth * 14 + Math.max(0, flow - 1.2) * 8,
      regimeScore: context.regime.volatility === 'compressed' ? 94 : 78,
      executionScore: 90 - (context.feed.spreadBps || 0) * 3 - context.orderFlow.bookFragility * 25,
      rationale: [
        `five-minute compression score ${compression.toFixed(2)}`,
        `${direction} breakout accepted ${(acceptance * 100).toFixed(1)}% beyond the range`,
        `second candle retested and held the boundary`,
        `breakout volume ${volumeRatio.toFixed(2)}x baseline with depth ${alignedDepth.toFixed(2)}`,
      ],
      features: { compression, volumeRatio, acceptance, rangeHigh, rangeLow, alignedDepth, flowRatio: flow,
        confirmationClose: confirmation.close },
    })];
  },
};'''

orderflow = r'''const orderFlowAbsorption: StrategyDefinition = {
  id: 'btc-orderflow-absorption',
  version: '0.3.0-shadow',
  name: 'Confirmed Order-Flow Absorption',
  description: 'Research-only continuation model requiring stable depth, extreme absorption, persistent aggressive flow and a completed price break before a retest entry.',
  mode: 'shadow',
  leverageCap: 15,
  evaluate(context): StrategyCandidate[] {
    if (!context.feed.healthy || !context.feed.derivativesHealthy
      || !['deep', 'normal'].includes(context.regime.liquidity)
      || context.regime.event !== 'normal' || context.orderFlow.bookFragility > 0.3) return [];
    const absorption = context.orderFlow.absorptionScore;
    const depth = context.orderFlow.depthImbalance5Bps;
    const buy = context.orderFlow.aggressiveBuyUsd1m;
    const sell = context.orderFlow.aggressiveSellUsd1m;
    const flow = safeDiv(buy, sell, 1);
    let direction: BtcDirection | null = null;
    if (absorption >= 0.8 && depth >= 0.5 && flow >= 2) direction = 'long';
    if (absorption >= 0.8 && depth <= -0.5 && flow <= 0.5) direction = 'short';
    if (!direction) return [];
    if ((direction === 'long' && ['bear', 'strong_bear'].includes(context.regime.direction))
      || (direction === 'short' && ['bull', 'strong_bull'].includes(context.regime.direction))) return [];

    const candles = complete(context.candles.oneMinute);
    const latest = candles.at(-1);
    const previous = candles.at(-2);
    if (!latest || !previous) return [];
    const atr = averageTrueRange(candles, 20);
    if (!(atr > 0)) return [];
    const confirmed = direction === 'long'
      ? latest.close > previous.high && latest.close > latest.open && latest.close >= latest.high - (latest.high - latest.low) * 0.35
      : latest.close < previous.low && latest.close < latest.open && latest.close <= latest.low + (latest.high - latest.low) * 0.35;
    if (!confirmed) return [];

    const entry = direction === 'long' ? previous.high : previous.low;
    const stop = direction === 'long'
      ? Math.min(previous.low, latest.low) - atr * 0.25
      : Math.max(previous.high, latest.high) + atr * 0.25;
    const initialTarget = targetFromRisk(entry, stop, direction, 4.5);
    return [candidate(context, {
      strategyId: this.id, strategyVersion: this.version, strategyName: this.name, mode: this.mode,
      direction, setupType: 'confirmed_absorption_break_retest', entryMethod: 'retest', preferredEntry: entry,
      entryZoneLow: entry - atr * 0.12,
      entryZoneHigh: entry + atr * 0.12,
      doNotChasePrice: direction === 'long' ? entry + atr * 0.45 : entry - atr * 0.45,
      expiresAt: context.timestamp + 6 * 60_000, structuralStop: stop, initialTarget,
      extendedTarget: targetFromRisk(entry, stop, direction, 6.5),
      maximumRealisticTarget: direction === 'long' ? entry + atr * 14 : entry - atr * 14,
      strategyLeverageCap: this.leverageCap, expectedHoldingMinutes: 45, exitModel: 'partial_runner',
      signalScore: 65 + absorption * 20 + Math.min(12, Math.abs(depth) * 15) + Math.min(10, Math.abs(Math.log(Math.max(flow, 0.01))) * 6),
      regimeScore: context.regime.direction === 'range' ? 78 : 84,
      executionScore: 94 - context.orderFlow.bookFragility * 45 - (context.feed.spreadBps || 0) * 5,
      rationale: [
        `absorption score ${absorption.toFixed(2)}`,
        `stable five-basis-point depth imbalance ${depth.toFixed(2)}`,
        `one-minute aggressive-flow ratio ${flow.toFixed(2)}`,
        'completed one-minute price break must retest before entry',
      ],
      features: { absorption, depth, flow, bookFragility: context.orderFlow.bookFragility, atr,
        confirmationClose: latest.close, retestLevel: entry },
    })];
  },
};'''

replace_once(
    'src/btc/platform/strategies.ts',
    r"const momentumRetest: StrategyDefinition = \{.*?\n\};\n\nconst compressionBreakout",
    momentum + "\n\nconst compressionBreakout",
)
replace_once(
    'src/btc/platform/strategies.ts',
    r"const compressionBreakout: StrategyDefinition = \{.*?\n\};\n\nconst liquiditySweep",
    compression + "\n\nconst liquiditySweep",
)
replace_once(
    'src/btc/platform/strategies.ts',
    r"const orderFlowAbsorption: StrategyDefinition = \{.*?\n\};\n\nconst crossVenueLag",
    orderflow + "\n\nconst crossVenueLag",
)

Path('src/btc/platform/wave2/cvd-divergence.ts').write_text(r'''import { averageTrueRange, safeDiv } from '../indicators';
import { BtcDirection, StrategyCandidate, StrategyDefinition } from '../types';
import { candleDelta, candidate, complete, currentPrice, directionalFlow, executionScore, targetFromRisk } from './shared';

export const cvdDivergence: StrategyDefinition = {
  id: 'btc-cvd-divergence',
  version: '0.2.0-shadow',
  name: 'Confirmed CVD Divergence',
  description: 'Researches a meaningful price extreme against reversing aggressive delta only after a completed structural reclaim.',
  mode: 'shadow',
  leverageCap: 12,
  evaluate(context): StrategyCandidate[] {
    if (!context.feed.healthy || !['deep', 'normal'].includes(context.regime.liquidity)
      || context.regime.event !== 'normal' || context.orderFlow.bookFragility > 0.4) return [];
    const candles = complete(context.candles.oneMinute);
    if (candles.length < 36) return [];
    const sample = candles.slice(-30);
    const first = sample.slice(0, 15);
    const second = sample.slice(15);
    const firstVolume = first.reduce((sum, candle) => sum + candle.buyVolume + candle.sellVolume, 0);
    const secondVolume = second.reduce((sum, candle) => sum + candle.buyVolume + candle.sellVolume, 0);
    if (firstVolume <= 0 || secondVolume <= 0) return [];

    const firstDelta = first.reduce((sum, candle) => sum + candleDelta(candle), 0);
    const secondDelta = second.reduce((sum, candle) => sum + candleDelta(candle), 0);
    const totalVolume = firstVolume + secondVolume;
    const deltaDivergence = safeDiv(secondDelta - firstDelta, totalVolume, 0);
    const firstLow = Math.min(...first.map(candle => candle.low));
    const secondLow = Math.min(...second.map(candle => candle.low));
    const firstHigh = Math.max(...first.map(candle => candle.high));
    const secondHigh = Math.max(...second.map(candle => candle.high));
    const latest = second.at(-1)!;
    const previous = second.at(-2)!;
    const atr = averageTrueRange(candles, 20);
    if (!(atr > 0)) return [];

    const bullish = secondLow <= firstLow - atr * 0.25 && firstDelta < 0 && secondDelta > 0
      && deltaDivergence >= 0.1 && latest.close > previous.high && latest.close > latest.open
      && !['bear', 'strong_bear'].includes(context.regime.direction);
    const bearish = secondHigh >= firstHigh + atr * 0.25 && firstDelta > 0 && secondDelta < 0
      && deltaDivergence <= -0.1 && latest.close < previous.low && latest.close < latest.open
      && !['bull', 'strong_bull'].includes(context.regime.direction);
    const direction: BtcDirection | null = bullish ? 'long' : bearish ? 'short' : null;
    if (!direction) return [];

    const flow = directionalFlow(context, direction, 'one');
    if (flow < 1.35) return [];
    const entry = currentPrice(context, direction);
    const divergenceExtreme = direction === 'long' ? secondLow : secondHigh;
    const stop = direction === 'long' ? divergenceExtreme - atr * 0.25 : divergenceExtreme + atr * 0.25;
    const initialTarget = targetFromRisk(entry, stop, direction, 4.2);
    const extendedTarget = targetFromRisk(entry, stop, direction, 6.2);

    return [candidate(context, {
      strategyId: this.id,
      strategyVersion: this.version,
      strategyName: this.name,
      mode: this.mode,
      direction,
      setupType: direction === 'long' ? 'confirmed_bullish_cvd_divergence' : 'confirmed_bearish_cvd_divergence',
      entryMethod: 'retest',
      preferredEntry: entry,
      entryZoneLow: entry - atr * 0.08,
      entryZoneHigh: entry + atr * 0.08,
      doNotChasePrice: direction === 'long' ? entry + atr * 0.35 : entry - atr * 0.35,
      expiresAt: context.timestamp + 8 * 60_000,
      structuralStop: stop,
      initialTarget,
      extendedTarget,
      maximumRealisticTarget: direction === 'long' ? entry + atr * 16 : entry - atr * 16,
      strategyLeverageCap: this.leverageCap,
      expectedHoldingMinutes: 75,
      exitModel: 'partial_runner',
      signalScore: 74 + Math.min(16, Math.abs(deltaDivergence) * 90) + Math.max(0, flow - 1.35) * 10,
      regimeScore: context.regime.direction === 'range' ? 92 : 80,
      executionScore: executionScore(context, 38),
      rationale: [
        `${direction} price extreme materially diverged from aggressive-volume delta`,
        `first-half delta ${firstDelta.toFixed(4)} versus second-half ${secondDelta.toFixed(4)}`,
        `normalized delta reversal ${(deltaDivergence * 100).toFixed(2)}%`,
        `completed structural reclaim with flow ratio ${flow.toFixed(2)}`,
      ],
      features: { firstDelta, secondDelta, deltaDivergence, firstLow, secondLow, firstHigh, secondHigh,
        flowRatio: flow, totalObservedVolume: totalVolume, atr, reclaimClose: latest.close },
    })];
  },
};
''')

risk_path = Path('src/btc/platform/research-risk.ts')
risk = risk_path.read_text()
risk = risk.replace(
    "import {\n  DEFAULT_COST_MODEL,",
    "import {\n  DEFAULT_COST_MODEL,",
)
risk = risk.replace(
    "function priceMovePct(entry: number, exit: number): number {",
    "export const DEFAULT_RESEARCH_MIN_NET_ROI_PCT = 4;\nexport const DEFAULT_RESEARCH_MIN_NET_RR = 1.5;\n\nfunction numberSetting(name: string, fallback: number): number {\n  const parsed = Number(process.env[name]);\n  return Number.isFinite(parsed) ? parsed : fallback;\n}\n\nfunction priceMovePct(entry: number, exit: number): number {",
)
risk = risk.replace(
    " * forcing actionable evidence maturity, standard ROI, or standard R gates. Feed, confidence, structural\n * loss, cost, and liquidation protections remain mandatory.",
    " * forcing actionable evidence maturity or actionable-tier thresholds. Research still requires\n * economically meaningful net ROI and net R after modeled costs, plus feed, confidence, structural-loss\n * and liquidation protections.",
)
risk = risk.replace(
    "  const maxPlannedLoss = Number(process.env.BTC_RESEARCH_MAX_PLANNED_LOSS_USD || DEFAULT_RESEARCH_MAX_PLANNED_LOSS_USD);\n  const targetDistancePct",
    "  const maxPlannedLoss = numberSetting('BTC_RESEARCH_MAX_PLANNED_LOSS_USD', DEFAULT_RESEARCH_MAX_PLANNED_LOSS_USD);\n  const minimumNetRoiPct = numberSetting('BTC_RESEARCH_MIN_NET_ROI_PCT', DEFAULT_RESEARCH_MIN_NET_ROI_PCT);\n  const minimumNetRR = numberSetting('BTC_RESEARCH_MIN_NET_RR', DEFAULT_RESEARCH_MIN_NET_RR);\n  const targetDistancePct",
)
risk = risk.replace(
    "    const estimatedRewardUsd = notionalUsd * targetDistancePct - Math.max(0, costs.totalEstimatedUsd);\n    if (!(estimatedRewardUsd > 0)) {\n      failures.add('native strategy target does not remain profitable after estimated costs');\n      continue;\n    }\n\n    const liquidationPrice",
    "    const estimatedRewardUsd = notionalUsd * targetDistancePct - Math.max(0, costs.totalEstimatedUsd);\n    if (!(estimatedRewardUsd > 0)) {\n      failures.add('native strategy target does not remain profitable after estimated costs');\n      continue;\n    }\n    const estimatedNetRR = safeDiv(estimatedRewardUsd, estimatedRiskUsd, 0);\n    const estimatedTargetRoiPct = estimatedRewardUsd / PAPER_MARGIN_USD * 100;\n    if (estimatedTargetRoiPct < minimumNetRoiPct) {\n      failures.add(`research target is below the ${minimumNetRoiPct.toFixed(1)}% projected net ROI quality floor`);\n      continue;\n    }\n    if (estimatedNetRR < minimumNetRR) {\n      failures.add(`research target is below the ${minimumNetRR.toFixed(2)}R net reward-to-risk quality floor`);\n      continue;\n    }\n\n    const liquidationPrice",
)
risk = risk.replace("    const estimatedNetRR = safeDiv(estimatedRewardUsd, estimatedRiskUsd, 0);\n\n    return {", "    return {")
risk = risk.replace("      estimatedTargetRoiPct: estimatedRewardUsd / PAPER_MARGIN_USD * 100,", "      estimatedTargetRoiPct,")
risk_path.write_text(risk)

research_test = Path('src/btc/platform/research-risk.test.ts')
text = research_test.read_text()
text = text.replace('initialTarget: 100_180,', 'initialTarget: 100_450,')
text = text.replace('maximumRealisticTarget: 100_180,', 'maximumRealisticTarget: 100_450,')
text = text.replace('maximumRealisticTarget: 100_180,\n  }));', 'maximumRealisticTarget: 100_450,\n  }));')
text = text.replace('assert.equal(research.targetPrice, 100_180);', 'assert.equal(research.targetPrice, 100_450);')
text = text.replace("test('research rejects a native target that is not profitable after estimated costs'", "test('research rejects a native target that is not profitable after estimated costs'")
text += r'''

test('research rejects positive but sub-1.5R economics', () => {
  const research = solveResearchRiskPlan(context, candidate({
    initialTarget: 100_160,
    maximumRealisticTarget: 100_160,
  }));
  assert.equal(research.approved, false);
  assert.ok(research.rejectionReasons.some(reason => reason.includes('reward-to-risk quality floor')
    || reason.includes('projected net ROI quality floor')));
});

test('approved research clears both economic quality floors', () => {
  const research = solveResearchRiskPlan(context, candidate());
  assert.equal(research.approved, true, research.rejectionReasons.join('; '));
  assert.ok(research.estimatedNetRR >= 1.5);
  assert.ok(research.estimatedTargetRoiPct >= 4);
});
'''
research_test.write_text(text)

wave2_test = Path('src/btc/platform/wave2-strategies.test.ts')
text = wave2_test.read_text()
text = text.replace("assert.equal(candidate.setupType, 'bullish_cvd_divergence');", "assert.equal(candidate.setupType, 'confirmed_bullish_cvd_divergence');")
text = text.replace("  assert.ok(plan.estimatedRewardUsd > 0);", "  assert.ok(plan.estimatedRewardUsd > 0);\n  assert.ok(plan.estimatedNetRR >= 1.5);\n  assert.ok(plan.estimatedTargetRoiPct >= 4);")
wave2_test.write_text(text)

Path('src/btc/platform/strategy-refinement.test.ts').write_text(r'''import assert from 'node:assert/strict';
import test from 'node:test';
import { BTC_STRATEGIES } from './strategy-registry';

function strategy(id: string) {
  const found = BTC_STRATEGIES.find(item => item.id === id);
  if (!found) throw new Error(`missing strategy ${id}`);
  return found;
}

test('failed first-iteration BTC strategies restart under refined versions and lower leverage caps', () => {
  assert.equal(strategy('btc-momentum-retest').version, '2.1.0');
  assert.equal(strategy('btc-momentum-retest').leverageCap, 18);
  assert.equal(strategy('btc-compression-breakout').version, '1.1.0');
  assert.equal(strategy('btc-compression-breakout').leverageCap, 20);
  assert.equal(strategy('btc-orderflow-absorption').version, '0.3.0-shadow');
  assert.equal(strategy('btc-orderflow-absorption').leverageCap, 15);
  assert.equal(strategy('btc-cvd-divergence').version, '0.2.0-shadow');
  assert.equal(strategy('btc-cvd-divergence').leverageCap, 12);
});
''')

public = Path('public/btc-dashboard.js')
text = public.read_text()
text = text.replace("researchMinimumNetRewardUsd: 'positive_after_estimated_costs',\n        researchForcedMinimumNetRR: false,",
                    "researchMinimumProjectedNetRoiPct: 4,\n        researchMinimumNetRR: 1.5,")
public.write_text(text)

print('BTC strategy refinement applied')
