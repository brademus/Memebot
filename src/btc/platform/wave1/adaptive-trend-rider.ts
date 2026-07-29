import { BtcDirection, StrategyCandidate, StrategyDefinition } from '../types';
import { averageTrueRange, directionalEfficiency, pct, rollingVwap, safeDiv } from '../indicators';
import { candidate, complete, currentPrice, directionalFlow, executionScore, observe, recentSwing, targetFromRisk } from './shared';

export const adaptiveTrendRider: StrategyDefinition = {
  id: 'btc-adaptive-trend-rider',
  version: '1.0.0',
  name: 'Six-Hour Adaptive Trend Rider',
  description: 'Trades rolling six-hour and daily trend alignment after a controlled intraday pullback and directional reclaim.',
  mode: 'actionable',
  leverageCap: 20,
  evaluate(context): StrategyCandidate[] {
    observe(context);
    if (!context.feed.healthy || context.regime.liquidity === 'dislocated' || context.regime.event === 'data_degraded') return [];
    const h1 = complete(context.candles.oneHour);
    const h4 = complete(context.candles.fourHour);
    const m15 = complete(context.candles.fifteenMinute);
    if (h1.length < 30 || h4.length < 8 || m15.length < 32) return [];

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
    if (
      sixHourReturn >= 0.35 && dayReturn >= 0.55 && twelveHourReturn >= 0.25
      && mark > h1Vwap && trendEfficiency >= 0.32
      && latest.close > latest.open && latest.close >= prior.close
    ) direction = 'long';
    if (
      sixHourReturn <= -0.35 && dayReturn <= -0.55 && twelveHourReturn <= -0.25
      && mark < h1Vwap && trendEfficiency >= 0.32
      && latest.close < latest.open && latest.close <= prior.close
    ) direction = 'short';
    if (!direction) return [];

    const recent = m15.slice(-10);
    const recentExtreme = direction === 'long'
      ? Math.max(...recent.map(candle => candle.high))
      : Math.min(...recent.map(candle => candle.low));
    const pullbackAtr = direction === 'long'
      ? safeDiv(recentExtreme - mark, atr, 0)
      : safeDiv(mark - recentExtreme, atr, 0);
    if (pullbackAtr < 0.12 || pullbackAtr > 2.6) return [];

    const entry = currentPrice(context, direction);
    const swing = recentSwing(m15, direction, 7);
    const stop = direction === 'long'
      ? Math.min(swing - atr * 0.14, entry - atr * 0.55)
      : Math.max(swing + atr * 0.14, entry + atr * 0.55);
    const initialTarget = targetFromRisk(entry, stop, direction, 3.25);
    const extendedTarget = targetFromRisk(entry, stop, direction, 6);
    const flow = directionalFlow(context, direction);

    return [candidate(context, {
      strategyId: this.id,
      strategyVersion: this.version,
      strategyName: this.name,
      mode: this.mode,
      direction,
      setupType: 'adaptive_trend_pullback',
      entryMethod: 'market',
      preferredEntry: entry,
      entryZoneLow: direction === 'long' ? entry - atr * 0.12 : entry - atr * 0.06,
      entryZoneHigh: direction === 'long' ? entry + atr * 0.06 : entry + atr * 0.12,
      doNotChasePrice: direction === 'long' ? entry + atr * 0.45 : entry - atr * 0.45,
      expiresAt: context.timestamp + 45 * 60_000,
      structuralStop: stop,
      initialTarget,
      extendedTarget,
      maximumRealisticTarget: direction === 'long'
        ? entry + Math.max(atr * 12, entry * 0.05)
        : entry - Math.max(atr * 12, entry * 0.05),
      strategyLeverageCap: this.leverageCap,
      expectedHoldingMinutes: 720,
      exitModel: 'partial_runner',
      signalScore: 62 + trendEfficiency * 16 + Math.min(12, Math.abs(sixHourReturn) * 6) + Math.max(0, flow - 1) * 10,
      regimeScore: 70 + Math.min(24, Math.abs(context.regime.directionalScore) * 0.3),
      executionScore: executionScore(context, 22),
      rationale: [
        `${direction} six-hour return ${sixHourReturn.toFixed(2)}% with daily alignment`,
        `twelve-hour return ${twelveHourReturn.toFixed(2)}%`,
        `trend efficiency ${trendEfficiency.toFixed(2)}`,
        `pullback depth ${pullbackAtr.toFixed(2)} ATR`,
      ],
      features: {
        sixHourReturn,
        dayReturn,
        twelveHourReturn,
        trendEfficiency,
        h1Vwap,
        pullbackAtr,
        flow,
        atr,
      },
    })];
  },
};
