from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]

def read(path):
    return (ROOT / path).read_text()

def write(path, content):
    (ROOT / path).write_text(content)

def replace_once(text, old, new, label):
    if text.count(old) != 1:
        raise RuntimeError(f"{label}: expected one exact match, found {text.count(old)}")
    return text.replace(old, new, 1)

def regex_once(text, pattern, replacement, label):
    updated, count = re.subn(pattern, replacement, text, count=1, flags=re.S)
    if count != 1:
        raise RuntimeError(f"{label}: expected one regex match, found {count}")
    return updated

# ---------------------------------------------------------------------------
# Types: retain backward-compatible optional directional microstructure fields.
# ---------------------------------------------------------------------------
path = 'src/btc/platform/types.ts'
text = read(path)
text = replace_once(text,
"""  absorptionScore: number;
  bids: BookLevel[];
""",
"""  absorptionScore: number;
  signedMovePct1m?: number;
  buyAbsorptionScore?: number;
  sellAbsorptionScore?: number;
  bids: BookLevel[];
""", 'types order-flow fields')
write(path, text)

# ---------------------------------------------------------------------------
# Runtime: rolling OI and directional absorption instead of unsigned pressure.
# ---------------------------------------------------------------------------
path = 'src/btc/runtime.ts'
text = read(path)
text = replace_once(text,
"""let openInterest = 0;
let openInterestValue = 0;
let openInterestBaseline = 0;
let openInterestBaselineAt = 0;
""",
"""let openInterest = 0;
let openInterestValue = 0;
const openInterestObservations: Array<{ at: number; value: number }> = [];
""", 'runtime OI state')
text = replace_once(text,
"""  while (ethObservations.length && ethObservations[0].at < crossAssetCutoff) ethObservations.shift();
}
""",
"""  while (ethObservations.length && ethObservations[0].at < crossAssetCutoff) ethObservations.shift();
  const oiCutoff = Date.now() - 90 * 60_000;
  while (openInterestObservations.length && openInterestObservations[0].at < oiCutoff) openInterestObservations.shift();
}

function recordOpenInterest(value: number, at = Date.now()): void {
  if (!(value > 0 && Number.isFinite(at))) return;
  const latest = openInterestObservations.at(-1);
  if (latest && at - latest.at < 5_000) {
    latest.at = at;
    latest.value = value;
  } else {
    openInterestObservations.push({ at, value });
  }
  const cutoff = at - 90 * 60_000;
  while (openInterestObservations.length && openInterestObservations[0].at < cutoff) openInterestObservations.shift();
}

function rollingOpenInterestChangePct(minutes = 15, now = Date.now()): number {
  const target = now - minutes * 60_000;
  const baseline = [...openInterestObservations].reverse().find(item => item.at <= target)
    || openInterestObservations[0];
  return baseline?.value > 0 && openInterest > 0 ? (openInterest / baseline.value - 1) * 100 : 0;
}
""", 'runtime OI helpers')
text = replace_once(text,
"""    const nextOi = numeric(row.openInterest) ?? openInterest;
    const nextOiValue = numeric(row.openInterestValue) ?? openInterestValue;
    if (!openInterestBaseline || now - openInterestBaselineAt > 15 * 60_000) {
      openInterestBaseline = nextOi;
      openInterestBaselineAt = now;
    }
    openInterest = nextOi;
    openInterestValue = nextOiValue;
""",
"""    const nextOi = numeric(row.openInterest) ?? openInterest;
    const nextOiValue = numeric(row.openInterestValue) ?? openInterestValue;
    openInterest = nextOi;
    openInterestValue = nextOiValue;
    recordOpenInterest(nextOi, now);
""", 'runtime OI update')
text = replace_once(text,
"""function flowSince(milliseconds: number, source: 'perp' | 'spot' | 'all' = 'all'): { buy: number; sell: number; movePct: number } {
  const cutoff = Date.now() - milliseconds;
  const sample = trades.filter(trade => trade.at >= cutoff && (source === 'all' || trade.source === source));
  const buy = sample.filter(trade => trade.direction === 'long').reduce((sum, trade) => sum + trade.usd, 0);
  const sell = sample.filter(trade => trade.direction === 'short').reduce((sum, trade) => sum + trade.usd, 0);
  const first = sample[0]?.price || 0;
  const final = sample.at(-1)?.price || first;
  return { buy, sell, movePct: first > 0 ? Math.abs(final - first) / first * 100 : 0 };
}
""",
"""function flowSince(milliseconds: number, source: 'perp' | 'spot' | 'all' = 'all'): {
  buy: number; sell: number; movePct: number; signedMovePct: number;
} {
  const cutoff = Date.now() - milliseconds;
  const sample = trades.filter(trade => trade.at >= cutoff && (source === 'all' || trade.source === source));
  const buy = sample.filter(trade => trade.direction === 'long').reduce((sum, trade) => sum + trade.usd, 0);
  const sell = sample.filter(trade => trade.direction === 'short').reduce((sum, trade) => sum + trade.usd, 0);
  const first = sample[0]?.price || 0;
  const final = sample.at(-1)?.price || first;
  const signedMovePct = first > 0 ? (final / first - 1) * 100 : 0;
  return { buy, sell, movePct: Math.abs(signedMovePct), signedMovePct };
}
""", 'runtime signed flow')
text = replace_once(text,
"""  const flowImbalance = Math.abs(safeDiv(one.buy - one.sell, one.buy + one.sell, 0));
  const expectedMove = safeDiv(flowImbalance * (one.buy + one.sell), Math.max(totalDepth, 1), 0);
  const absorptionScore = clamp(flowImbalance * 0.55 + (one.movePct < 0.04 ? 0.3 : 0) + (expectedMove > 1 && one.movePct < 0.08 ? 0.25 : 0), 0, 1);
  return {
""",
"""  const signedFlowImbalance = safeDiv(one.buy - one.sell, one.buy + one.sell, 0);
  const flowImbalance = Math.abs(signedFlowImbalance);
  const expectedMove = safeDiv(flowImbalance * (one.buy + one.sell), Math.max(totalDepth, 1), 0);
  const buyPressure = Math.max(0, signedFlowImbalance);
  const sellPressure = Math.max(0, -signedFlowImbalance);
  const buyAbsorptionScore = clamp(
    buyPressure * 0.45
      + (buyPressure >= 0.2 && one.signedMovePct <= 0.015 ? 0.25 : 0)
      + (buyPressure >= 0.2 && one.signedMovePct < 0 ? 0.2 : 0)
      + Math.max(0, -depthImbalance5Bps) * 0.15,
    0,
    1,
  );
  const sellAbsorptionScore = clamp(
    sellPressure * 0.45
      + (sellPressure >= 0.2 && one.signedMovePct >= -0.015 ? 0.25 : 0)
      + (sellPressure >= 0.2 && one.signedMovePct > 0 ? 0.2 : 0)
      + Math.max(0, depthImbalance5Bps) * 0.15,
    0,
    1,
  );
  const absorptionScore = Math.max(buyAbsorptionScore, sellAbsorptionScore);
  return {
""", 'runtime directional absorption')
text = replace_once(text,
"""    absorptionScore,
    bids: bidLevels,
""",
"""    absorptionScore,
    signedMovePct1m: one.signedMovePct,
    buyAbsorptionScore,
    sellAbsorptionScore,
    bids: bidLevels,
""", 'runtime directional absorption output')
text = replace_once(text,
"""  const openInterestChangePct = openInterestBaseline > 0 ? (openInterest / openInterestBaseline - 1) * 100 : 0;
""",
"""  const openInterestChangePct = rollingOpenInterestChangePct(15, now);
""", 'runtime rolling OI context')
write(path, text)

# ---------------------------------------------------------------------------
# Risk: reject strategies whose modeled friction consumes structural edge.
# ---------------------------------------------------------------------------
path = 'src/btc/platform/risk.ts'
text = read(path)
text = replace_once(text,
"""export const DEFAULT_RESEARCH_MAX_PLANNED_LOSS_USD = 20 / 3;
""",
"""export const DEFAULT_RESEARCH_MAX_PLANNED_LOSS_USD = 20 / 3;
export const DEFAULT_MAX_COST_TO_GROSS_RISK = 0.30;
""", 'risk friction constant')
text = replace_once(text,
"""  const maxPlannedLoss = numberSetting('BTC_MAX_PLANNED_LOSS_USD', DEFAULT_MAX_PLANNED_LOSS_USD);
  const targetDistancePct = priceMovePct(candidate.preferredEntry, targetPrice);
""",
"""  const maxPlannedLoss = numberSetting('BTC_MAX_PLANNED_LOSS_USD', DEFAULT_MAX_PLANNED_LOSS_USD);
  const maximumCostToGrossRisk = numberSetting('BTC_MAX_COST_TO_GROSS_RISK', DEFAULT_MAX_COST_TO_GROSS_RISK);
  const targetDistancePct = priceMovePct(candidate.preferredEntry, targetPrice);
""", 'risk friction setting')
text = replace_once(text,
"""    const estimatedRewardUsd = notionalUsd * targetDistancePct - Math.max(0, costs.totalEstimatedUsd);
    const estimatedNetRR = safeDiv(estimatedRewardUsd, estimatedRiskUsd, 0);
""",
"""    const estimatedRewardUsd = notionalUsd * targetDistancePct - Math.max(0, costs.totalEstimatedUsd);
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
""", 'risk friction loop')
text = replace_once(text,
"""    if (!(estimatedRewardUsd > 0)) {
      failures.add('native strategy target does not remain profitable after estimated costs');
      continue;
    }
""", '', 'risk remove duplicate reward check')
write(path, text)

path = 'src/btc/platform/research-risk.ts'
text = read(path)
text = replace_once(text,
"""  DEFAULT_COST_MODEL,
  DEFAULT_RESEARCH_MAX_PLANNED_LOSS_USD,
""",
"""  DEFAULT_COST_MODEL,
  DEFAULT_MAX_COST_TO_GROSS_RISK,
  DEFAULT_RESEARCH_MAX_PLANNED_LOSS_USD,
""", 'research friction import')
text = replace_once(text,
"""  const minimumNetRR = numberSetting('BTC_RESEARCH_MIN_NET_RR', DEFAULT_RESEARCH_MIN_NET_RR);
  const targetDistancePct = priceMovePct(candidate.preferredEntry, targetPrice);
""",
"""  const minimumNetRR = numberSetting('BTC_RESEARCH_MIN_NET_RR', DEFAULT_RESEARCH_MIN_NET_RR);
  const maximumCostToGrossRisk = numberSetting('BTC_MAX_COST_TO_GROSS_RISK', DEFAULT_MAX_COST_TO_GROSS_RISK);
  const targetDistancePct = priceMovePct(candidate.preferredEntry, targetPrice);
""", 'research friction setting')
text = replace_once(text,
"""    const estimatedNetRR = safeDiv(estimatedRewardUsd, estimatedRiskUsd, 0);
    const estimatedTargetRoiPct = estimatedRewardUsd / PAPER_MARGIN_USD * 100;
""",
"""    const grossRiskUsd = notionalUsd * stopDistancePct;
    const costToGrossRisk = safeDiv(Math.max(0, costs.totalEstimatedUsd), grossRiskUsd, Infinity);
    if (!(grossRiskUsd > 0) || costToGrossRisk > maximumCostToGrossRisk) {
      failures.add(`modeled round-trip friction exceeds ${(maximumCostToGrossRisk * 100).toFixed(0)}% of gross structural risk`);
      continue;
    }
    const estimatedNetRR = safeDiv(estimatedRewardUsd, estimatedRiskUsd, 0);
    const estimatedTargetRoiPct = estimatedRewardUsd / PAPER_MARGIN_USD * 100;
""", 'research friction loop')
write(path, text)

# ---------------------------------------------------------------------------
# Engine: real stop triggers, one research exposure, no duplicate book, and
# fill-time risk recalculation using the actual executable price.
# ---------------------------------------------------------------------------
path = 'src/btc/platform/engine.ts'
text = read(path)
text = replace_once(text,
"""  if (candidate.entryMethod === 'market') return true;
  return price >= candidate.entryZoneLow && price <= candidate.entryZoneHigh;
""",
"""  if (candidate.entryMethod === 'market') return true;
  if (candidate.entryMethod === 'stop') {
    return candidate.direction === 'long'
      ? price >= candidate.preferredEntry && price <= candidate.doNotChasePrice
      : price <= candidate.preferredEntry && price >= candidate.doNotChasePrice;
  }
  return price >= candidate.entryZoneLow && price <= candidate.entryZoneHigh;
""", 'engine stop semantics')
text = regex_once(text,
r"  private async armResearch\(candidate: StrategyCandidate, plan: RiskPlan\): Promise<void> \{.*?\n  \}\n\n  private selectActionable",
"""  private hasResearchExposure(): boolean {
    const active = this.activeCalls.some(call => call.book === 'research' && activeStates.has(call.status));
    const armed = [...this.armed.values()].some(item => item.book === 'research');
    return active || armed;
  }

  private async armResearch(candidate: StrategyCandidate, plan: RiskPlan): Promise<boolean> {
    if (!plan.approved) {
      await persistRiskDecision(candidate, 'research', plan, plan.rejectionReasons);
      return false;
    }
    if (this.hasResearchExposure()) {
      await persistRiskDecision(candidate, 'research', plan, ['global research exposure is already active or armed']);
      return false;
    }
    if (this.strategyHasActiveResearch(candidate.strategyId)) {
      await persistRiskDecision(candidate, 'research', plan, ['research strategy already has an active call']);
      return false;
    }
    if (this.strategyCooldownActive(candidate)) {
      await persistRiskDecision(candidate, 'research', plan, ['strategy cooldown is active']);
      return false;
    }
    await persistRiskDecision(candidate, 'research', plan);
    this.armed.set(`research:${candidate.id}`, {
      candidate, plan, book: 'research', supportingStrategies: [candidate.strategyId], armedAt: candidate.createdAt,
    });
    return true;
  }

  private selectActionable""", 'engine research coordinator')
text = replace_once(text,
"""    for (const item of actionable) await this.armActionable(item.candidate, item.plan, item.supporting);
    for (const item of fresh) await this.armResearch(item.candidate, item.researchPlan);
""",
"""    for (const item of actionable) await this.armActionable(item.candidate, item.plan, item.supporting);

    const actionableCandidateIds = new Set(actionable.map(item => item.candidate.id));
    const researchPool = fresh
      .filter(item => !actionableCandidateIds.has(item.candidate.id))
      .filter(item => item.candidate.mode === 'shadow' || !item.actionablePlan.approved)
      .sort((a, b) => combinedConfidence(b.candidate) - combinedConfidence(a.candidate));
    let selectedResearch = false;
    for (const item of researchPool) {
      if (!item.researchPlan.approved) {
        await persistRiskDecision(item.candidate, 'research', item.researchPlan, item.researchPlan.rejectionReasons);
        continue;
      }
      if (!selectedResearch && !this.hasResearchExposure()) {
        selectedResearch = await this.armResearch(item.candidate, item.researchPlan);
        if (selectedResearch) continue;
      }
      await persistRiskDecision(item.candidate, 'research', item.researchPlan, [
        'not selected by global research event coordinator; correlated market exposure already selected',
      ]);
    }
""", 'engine research selection')
text = replace_once(text,
"""      const { call, event } = createPaperCall(
        armed.candidate,
        armed.plan,
        context,
        armed.book,
        armed.supportingStrategies,
      );
""",
"""      const fillPrice = executableEntry(context, armed.candidate);
      const repricedCandidate: StrategyCandidate = { ...armed.candidate, preferredEntry: fillPrice };
      const evidence = this.performance.find(item => item.strategyId === repricedCandidate.strategyId
        && item.strategyVersion === repricedCandidate.strategyVersion) || null;
      const repricedPlan = armed.book === 'research'
        ? solveResearchRiskPlan(context, repricedCandidate)
        : solveRiskPlan(context, repricedCandidate, evidence);
      if (!repricedPlan.approved) {
        this.armed.delete(key);
        await persistRiskDecision(repricedCandidate, armed.book, repricedPlan, [
          ...repricedPlan.rejectionReasons,
          'actual executable fill failed risk revalidation',
        ]);
        await markCandidateDecision(armed.candidate.id, 'cancelled', 'actual executable fill failed risk revalidation');
        continue;
      }
      const { call, event } = createPaperCall(
        repricedCandidate,
        repricedPlan,
        context,
        armed.book,
        armed.supportingStrategies,
      );
""", 'engine fill revalidation')
write(path, text)

# ---------------------------------------------------------------------------
# Core strategies: delayed triggers and correct absorption interpretation.
# ---------------------------------------------------------------------------
path = 'src/btc/platform/strategies.ts'
text = read(path)
momentum = r'''const momentumRetest: StrategyDefinition = {
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
'''
compression = r'''const compressionBreakout: StrategyDefinition = {
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
'''
orderflow = r'''const orderFlowAbsorption: StrategyDefinition = {
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
'''
text = regex_once(text, r"const momentumRetest: StrategyDefinition = \{.*?\n\};\n\nconst compressionBreakout", momentum + "\nconst compressionBreakout", 'momentum replacement')
text = regex_once(text, r"const compressionBreakout: StrategyDefinition = \{.*?\n\};\n\nconst liquiditySweep", compression + "\nconst liquiditySweep", 'compression replacement')
text = regex_once(text, r"const orderFlowAbsorption: StrategyDefinition = \{.*?\n\};\n\nconst crossVenueLag", orderflow + "\nconst crossVenueLag", 'absorption replacement')
write(path, text)

# ---------------------------------------------------------------------------
# True pivot-to-pivot CVD divergence with live sided-volume coverage.
# ---------------------------------------------------------------------------
write('src/btc/platform/wave2/cvd-divergence.ts', r'''import { averageTrueRange, safeDiv } from '../indicators';
import { BtcDirection, Candle, StrategyCandidate, StrategyDefinition } from '../types';
import { candleDelta, candidate, complete, directionalFlow, executionScore, targetFromRisk } from './shared';

interface Pivot {
  index: number;
  price: number;
  cvd: number;
}

function pivots(candles: Candle[], cumulativeDelta: number[], side: 'low' | 'high', radius = 2): Pivot[] {
  const found: Pivot[] = [];
  for (let index = radius; index < candles.length - radius; index++) {
    const value = side === 'low' ? candles[index].low : candles[index].high;
    const neighbors = candles.slice(index - radius, index + radius + 1)
      .filter((_, offset) => offset !== radius)
      .map(candle => side === 'low' ? candle.low : candle.high);
    const isPivot = side === 'low' ? neighbors.every(candidate => value <= candidate) : neighbors.every(candidate => value >= candidate);
    if (isPivot) found.push({ index, price: value, cvd: cumulativeDelta[index] });
  }
  return found;
}

export const cvdDivergence: StrategyDefinition = {
  id: 'btc-cvd-divergence',
  version: '0.3.0-shadow',
  name: 'Pivot-Confirmed CVD Divergence',
  description: 'Compares cumulative aggressive-volume delta at two confirmed price pivots and waits for a structural reclaim plus a new trigger.',
  mode: 'shadow',
  leverageCap: 8,
  evaluate(context): StrategyCandidate[] {
    if (!context.feed.healthy || !['deep', 'normal'].includes(context.regime.liquidity)
      || context.regime.event !== 'normal' || context.orderFlow.bookFragility > 0.35
      || Math.abs(context.regime.directionalScore) > 35) return [];
    const candles = complete(context.candles.oneMinute).slice(-60);
    if (candles.length < 45) return [];
    const sample = candles.slice(-45);
    if (sample.some(candle => candle.tradeCount <= 0 || candle.buyVolume + candle.sellVolume <= 0)) return [];
    const totalVolume = sample.reduce((sum, candle) => sum + candle.buyVolume + candle.sellVolume, 0);
    if (!(totalVolume > 0)) return [];
    let running = 0;
    const cumulativeDelta = sample.map(candle => {
      running += candleDelta(candle);
      return running;
    });
    const atr = averageTrueRange(sample, 20);
    if (!(atr > 0)) return [];
    const lows = pivots(sample, cumulativeDelta, 'low');
    const highs = pivots(sample, cumulativeDelta, 'high');
    const latest = sample.at(-1)!;

    let direction: BtcDirection | null = null;
    let first: Pivot | null = null;
    let second: Pivot | null = null;
    let reclaimLevel = 0;
    if (lows.length >= 2) {
      [first, second] = lows.slice(-2);
      const priceLowerLow = second.price <= first.price - atr * 0.15;
      const cvdHigherLow = second.cvd >= first.cvd + totalVolume * 0.03;
      reclaimLevel = Math.max(...sample.slice(second.index + 1, -1).map(candle => candle.high), sample[second.index].high);
      if (priceLowerLow && cvdHigherLow && latest.close > reclaimLevel && latest.close > latest.open) direction = 'long';
    }
    if (!direction && highs.length >= 2) {
      [first, second] = highs.slice(-2);
      const priceHigherHigh = second.price >= first.price + atr * 0.15;
      const cvdLowerHigh = second.cvd <= first.cvd - totalVolume * 0.03;
      reclaimLevel = Math.min(...sample.slice(second.index + 1, -1).map(candle => candle.low), sample[second.index].low);
      if (priceHigherHigh && cvdLowerHigh && latest.close < reclaimLevel && latest.close < latest.open) direction = 'short';
    }
    if (!direction || !first || !second) return [];
    const flow = directionalFlow(context, direction, 'one');
    if (flow < 1.15) return [];
    const entry = direction === 'long' ? latest.high + atr * 0.04 : latest.low - atr * 0.04;
    const stop = direction === 'long' ? second.price - atr * 0.22 : second.price + atr * 0.22;
    const initialTarget = targetFromRisk(entry, stop, direction, 3.6);
    return [candidate(context, {
      strategyId: this.id,
      strategyVersion: this.version,
      strategyName: this.name,
      mode: this.mode,
      direction,
      setupType: direction === 'long' ? 'pivot_bullish_cvd_divergence' : 'pivot_bearish_cvd_divergence',
      entryMethod: 'stop',
      preferredEntry: entry,
      entryZoneLow: entry - atr * 0.02,
      entryZoneHigh: entry + atr * 0.02,
      doNotChasePrice: direction === 'long' ? entry + atr * 0.22 : entry - atr * 0.22,
      expiresAt: context.timestamp + 6 * 60_000,
      structuralStop: stop,
      initialTarget,
      extendedTarget: targetFromRisk(entry, stop, direction, 5.5),
      maximumRealisticTarget: direction === 'long' ? entry + atr * 14 : entry - atr * 14,
      strategyLeverageCap: this.leverageCap,
      expectedHoldingMinutes: 90,
      exitModel: 'partial_runner',
      signalScore: 76 + Math.min(16, Math.abs(second.cvd - first.cvd) / totalVolume * 180) + Math.max(0, flow - 1.15) * 8,
      regimeScore: context.regime.direction === 'range' ? 94 : 82,
      executionScore: executionScore(context, 42),
      rationale: [
        `${direction} divergence compared cumulative delta at two confirmed price pivots`,
        `price pivot moved ${Math.abs(second.price - first.price).toFixed(2)} while CVD diverged`,
        `structural reclaim ${reclaimLevel.toFixed(2)} completed on fully live sided-volume candles`,
        `fresh trigger required with flow ratio ${flow.toFixed(2)}`,
      ],
      features: { firstPivotPrice: first.price, secondPivotPrice: second.price, firstPivotCvd: first.cvd,
        secondPivotCvd: second.cvd, totalObservedVolume: totalVolume, flowRatio: flow, atr, reclaimLevel, triggerPrice: entry },
    })];
  },
};
''')

# ---------------------------------------------------------------------------
# Adaptive trend: eliminate shallow market entries after already-extended moves.
# ---------------------------------------------------------------------------
write('src/btc/platform/wave1/adaptive-trend-rider.ts', r'''import { BtcDirection, StrategyCandidate, StrategyDefinition } from '../types';
import { averageTrueRange, directionalEfficiency, pct, rollingVwap, safeDiv } from '../indicators';
import { candidate, complete, directionalFlow, executionScore, observe, recentSwing, targetFromRisk } from './shared';

export const adaptiveTrendRider: StrategyDefinition = {
  id: 'btc-adaptive-trend-rider',
  version: '2.0.0',
  name: 'Deep-Pullback Adaptive Trend Rider',
  description: 'Trades persistent six-hour and daily trends only after a meaningful pullback, a completed reclaim, and a fresh stop trigger.',
  mode: 'actionable',
  leverageCap: 10,
  evaluate(context): StrategyCandidate[] {
    observe(context);
    if (!context.feed.healthy || context.regime.liquidity === 'dislocated' || context.regime.event !== 'normal') return [];
    const h1 = complete(context.candles.oneHour);
    const h4 = complete(context.candles.fourHour);
    const m15 = complete(context.candles.fifteenMinute);
    if (h1.length < 30 || h4.length < 8 || m15.length < 36) return [];
    const mark = context.prices.mark;
    const sixHourReturn = pct(h1.at(-7)!.close, mark);
    const dayReturn = pct(h1.at(-25)!.close, mark);
    const twelveHourReturn = pct(h4.at(-4)!.close, mark);
    const trendEfficiency = directionalEfficiency(h1, 12);
    const h1Vwap = rollingVwap(h1, 24);
    const latest = m15.at(-1)!;
    const prior = m15.at(-2)!;
    const atr = averageTrueRange(m15, 14);
    if (!(atr > 0)) return [];

    let direction: BtcDirection | null = null;
    if (sixHourReturn >= 0.45 && dayReturn >= 0.65 && twelveHourReturn >= 0.3
      && mark > h1Vwap && trendEfficiency >= 0.38 && ['bull', 'strong_bull'].includes(context.regime.direction)) direction = 'long';
    if (sixHourReturn <= -0.45 && dayReturn <= -0.65 && twelveHourReturn <= -0.3
      && mark < h1Vwap && trendEfficiency >= 0.38 && ['bear', 'strong_bear'].includes(context.regime.direction)) direction = 'short';
    if (!direction) return [];

    const recent = m15.slice(-12);
    const recentExtreme = direction === 'long' ? Math.max(...recent.map(candle => candle.high)) : Math.min(...recent.map(candle => candle.low));
    const pullbackAtr = direction === 'long' ? safeDiv(recentExtreme - prior.low, atr, 0) : safeDiv(prior.high - recentExtreme, atr, 0);
    if (pullbackAtr < 0.6 || pullbackAtr > 2.2) return [];
    const reclaim = direction === 'long'
      ? latest.close > prior.high && latest.close > latest.open
      : latest.close < prior.low && latest.close < latest.open;
    if (!reclaim) return [];
    const flow = directionalFlow(context, direction);
    if (flow < 1.1) return [];

    const entry = direction === 'long' ? latest.high + atr * 0.05 : latest.low - atr * 0.05;
    const swing = recentSwing(m15.slice(0, -1), direction, 9);
    const stop = direction === 'long' ? Math.min(swing - atr * 0.15, prior.low - atr * 0.12)
      : Math.max(swing + atr * 0.15, prior.high + atr * 0.12);
    const initialTarget = targetFromRisk(entry, stop, direction, 3.4);
    return [candidate(context, {
      strategyId: this.id, strategyVersion: this.version, strategyName: this.name, mode: this.mode,
      direction, setupType: 'deep_trend_pullback_reclaim', entryMethod: 'stop', preferredEntry: entry,
      entryZoneLow: entry - atr * 0.02, entryZoneHigh: entry + atr * 0.02,
      doNotChasePrice: direction === 'long' ? entry + atr * 0.25 : entry - atr * 0.25,
      expiresAt: context.timestamp + 30 * 60_000, structuralStop: stop, initialTarget,
      extendedTarget: targetFromRisk(entry, stop, direction, 5.5),
      maximumRealisticTarget: direction === 'long' ? entry + Math.max(atr * 14, entry * 0.035)
        : entry - Math.max(atr * 14, entry * 0.035),
      strategyLeverageCap: this.leverageCap, expectedHoldingMinutes: 600, exitModel: 'partial_runner',
      signalScore: 68 + trendEfficiency * 16 + Math.min(12, Math.abs(sixHourReturn) * 5) + Math.max(0, flow - 1.1) * 8,
      regimeScore: 76 + Math.min(20, Math.abs(context.regime.directionalScore) * 0.25),
      executionScore: executionScore(context, 26),
      rationale: [
        `${direction} six-hour return ${sixHourReturn.toFixed(2)}% with daily and twelve-hour alignment`,
        `trend efficiency ${trendEfficiency.toFixed(2)}`,
        `meaningful pullback depth ${pullbackAtr.toFixed(2)} ATR`,
        'completed reclaim plus a fresh continuation trigger required',
      ],
      features: { sixHourReturn, dayReturn, twelveHourReturn, trendEfficiency, h1Vwap, pullbackAtr, flow, atr,
        triggerPrice: entry },
    })];
  },
};
''')

# ---------------------------------------------------------------------------
# Execution telemetry: persist entry market context and gross price excursions.
# ---------------------------------------------------------------------------
path = 'src/btc/platform/execution.ts'
text = read(path)
text = replace_once(text,
"""  call.maxFavorableR = Math.max(call.maxFavorableR, call.currentR);
  call.maxAdverseR = Math.min(call.maxAdverseR, call.currentR);
  updatePnlAccountingFeatures(call, projectedExitCostsUsd);
""",
"""  call.maxFavorableR = Math.max(call.maxFavorableR, call.currentR);
  call.maxAdverseR = Math.min(call.maxAdverseR, call.currentR);
  const grossMovePct = directionalMove(call.direction, call.entryPrice, exit) * 100;
  call.features.grossMfePct = Math.max(Number(call.features.grossMfePct || 0), grossMovePct);
  call.features.grossMaePct = Math.min(Number(call.features.grossMaePct || 0), grossMovePct);
  updatePnlAccountingFeatures(call, projectedExitCostsUsd);
""", 'execution gross excursions')
text = replace_once(text,
"""      estimatedSpreadUsdIncludedInExecutablePrices: plan.costs.spreadUsd,
""",
"""      estimatedSpreadUsdIncludedInExecutablePrices: plan.costs.spreadUsd,
      actualEntrySlippageBps: Math.abs(fill - plan.entryPrice) / Math.max(plan.entryPrice, 1) * 10_000,
      costToGrossRiskPct: plan.notionalUsd * Math.abs(fill - plan.stopPrice) / Math.max(fill, 1) > 0
        ? plan.costs.totalEstimatedUsd / (plan.notionalUsd * Math.abs(fill - plan.stopPrice) / Math.max(fill, 1)) * 100 : null,
      entryRegimeDirection: context.regime.direction,
      entryRegimeVolatility: context.regime.volatility,
      entryRegimeLiquidity: context.regime.liquidity,
      entryRegimePositioning: context.regime.positioning,
      entryRegimeEvent: context.regime.event,
      entryDirectionalScore: context.regime.directionalScore,
      entryVolatilityPercentile: context.regime.volatilityPercentile,
      entrySpreadBps: context.feed.spreadBps,
      entryBookFragility: context.orderFlow.bookFragility,
      entryDepthImbalance5Bps: context.orderFlow.depthImbalance5Bps,
      entryBuyAbsorptionScore: context.orderFlow.buyAbsorptionScore ?? null,
      entrySellAbsorptionScore: context.orderFlow.sellAbsorptionScore ?? null,
      grossMfePct: 0,
      grossMaePct: 0,
""", 'execution entry telemetry')
write(path, text)

# ---------------------------------------------------------------------------
# Update research economics fixtures and explicitly test friction rejection.
# ---------------------------------------------------------------------------
path = 'src/btc/platform/research-risk.test.ts'
text = read(path)
text = text.replace('structuralStop: 99_950,', 'structuralStop: 99_500,')
text = text.replace('initialTarget: 100_450,', 'initialTarget: 101_500,')
text = text.replace('maximumRealisticTarget: 100_450,', 'maximumRealisticTarget: 101_500,')
text = text.replace('initialTarget: 100_600,\n    maximumRealisticTarget: 100_450,', 'initialTarget: 102_000,\n    maximumRealisticTarget: 101_500,')
text = text.replace('assert.equal(research.targetPrice, 100_450);', 'assert.equal(research.targetPrice, 101_500);')
text = text.replace('initialTarget: 100_160,\n    maximumRealisticTarget: 100_160,', 'initialTarget: 100_700,\n    maximumRealisticTarget: 100_700,')
text = replace_once(text,
"""test('approved research clears both economic quality floors', () => {
""",
"""test('research rejects setups whose round-trip friction consumes structural risk', () => {
  const research = solveResearchRiskPlan(context, candidate({
    structuralStop: 99_950,
    initialTarget: 101_000,
    maximumRealisticTarget: 101_000,
  }));
  assert.equal(research.approved, false);
  assert.ok(research.rejectionReasons.some(reason => reason.includes('friction')));
});

test('approved research clears both economic quality floors', () => {
""", 'research friction test')
write(path, text)

print('Applied BTC market-aligned v3 redesign')
