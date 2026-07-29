import { averageTrueRange, safeDiv } from '../indicators';
import { BtcDirection, StrategyCandidate, StrategyDefinition } from '../types';
import { candleDelta, candidate, complete, currentPrice, directionalFlow, executionScore, targetFromRisk } from './shared';

export const cvdDivergence: StrategyDefinition = {
  id: 'btc-cvd-divergence',
  version: '0.1.0-shadow',
  name: 'CVD Divergence',
  description: 'Researches price extremes that are not confirmed by live aggressive-volume delta and then reclaim short-term structure.',
  mode: 'shadow',
  leverageCap: 20,
  evaluate(context): StrategyCandidate[] {
    if (!context.feed.healthy || context.regime.liquidity === 'dislocated') return [];
    const candles = complete(context.candles.oneMinute);
    if (candles.length < 30) return [];
    const sample = candles.slice(-24);
    const first = sample.slice(0, 12);
    const second = sample.slice(12);
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
    const bullish = secondLow < firstLow && secondDelta > 0 && deltaDivergence >= 0.06
      && latest.close > latest.open && latest.close > previous.close;
    const bearish = secondHigh > firstHigh && secondDelta < 0 && deltaDivergence <= -0.06
      && latest.close < latest.open && latest.close < previous.close;
    const direction: BtcDirection | null = bullish ? 'long' : bearish ? 'short' : null;
    if (!direction) return [];

    const flow = directionalFlow(context, direction, 'one');
    if (flow < 1.03) return [];
    const atr = averageTrueRange(candles, 20);
    if (!(atr > 0)) return [];
    const entry = currentPrice(context, direction);
    const divergenceExtreme = direction === 'long' ? secondLow : secondHigh;
    const stop = direction === 'long' ? divergenceExtreme - atr * 0.15 : divergenceExtreme + atr * 0.15;
    const initialTarget = targetFromRisk(entry, stop, direction, 3.4);
    const extendedTarget = targetFromRisk(entry, stop, direction, 5.2);

    return [candidate(context, {
      strategyId: this.id,
      strategyVersion: this.version,
      strategyName: this.name,
      mode: this.mode,
      direction,
      setupType: direction === 'long' ? 'bullish_cvd_divergence' : 'bearish_cvd_divergence',
      entryMethod: 'retest',
      preferredEntry: entry,
      entryZoneLow: direction === 'long' ? entry - atr * 0.18 : entry - atr * 0.06,
      entryZoneHigh: direction === 'long' ? entry + atr * 0.06 : entry + atr * 0.18,
      doNotChasePrice: direction === 'long' ? entry + atr * 0.55 : entry - atr * 0.55,
      expiresAt: context.timestamp + 18 * 60_000,
      structuralStop: stop,
      initialTarget,
      extendedTarget,
      maximumRealisticTarget: direction === 'long'
        ? entry + Math.max(atr * 18, entry * 0.05)
        : entry - Math.max(atr * 18, entry * 0.05),
      strategyLeverageCap: this.leverageCap,
      expectedHoldingMinutes: 75,
      exitModel: 'partial_runner',
      signalScore: 70 + Math.min(18, Math.abs(deltaDivergence) * 120) + Math.max(0, flow - 1) * 12,
      regimeScore: context.regime.direction === 'range' ? 88 : 76,
      executionScore: executionScore(context, 30),
      rationale: [
        `${direction} price extreme diverged from live cumulative aggressive-volume delta`,
        `first-half delta ${firstDelta.toFixed(4)} versus second-half ${secondDelta.toFixed(4)}`,
        `normalized delta divergence ${(deltaDivergence * 100).toFixed(2)}%`,
        `one-minute confirming flow ratio ${flow.toFixed(2)}`,
      ],
      features: {
        firstDelta,
        secondDelta,
        deltaDivergence,
        firstLow,
        secondLow,
        firstHigh,
        secondHigh,
        flowRatio: flow,
        totalObservedVolume: totalVolume,
        atr,
      },
    })];
  },
};
