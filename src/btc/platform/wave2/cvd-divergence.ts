import { averageTrueRange, safeDiv } from '../indicators';
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
