import { BtcDirection, StrategyCandidate, StrategyDefinition } from '../types';
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
