import { averageTrueRange, safeDiv } from '../indicators';
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
    if (candles.length < 30) return [];
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
