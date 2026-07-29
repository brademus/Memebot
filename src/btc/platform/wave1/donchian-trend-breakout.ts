import { BtcDirection, StrategyCandidate, StrategyDefinition } from '../types';
import { averageTrueRange, directionalEfficiency, median, safeDiv } from '../indicators';
import { candidate, complete, directionalFlow, executionScore, observe, targetFromRisk } from './shared';

export const donchianTrendBreakout: StrategyDefinition = {
  id: 'btc-donchian-trend-breakout',
  version: '1.0.0',
  name: 'Rolling Donchian Trend Breakout',
  description: 'Trades accepted breaks of rolling twelve-to-sixteen-hour extremes without requiring a prior compression regime.',
  mode: 'actionable',
  leverageCap: 30,
  evaluate(context): StrategyCandidate[] {
    observe(context);
    if (!context.feed.healthy || context.regime.liquidity === 'dislocated' || context.regime.volatility === 'extreme') return [];
    const candles = complete(context.candles.fifteenMinute);
    if (candles.length < 80) return [];
    const current = candles.at(-1)!;
    const prior = candles.slice(-65, -1);
    const channelLength = context.regime.volatility === 'elevated' ? 64 : 48;
    const channel = prior.slice(-channelLength);
    const channelHigh = Math.max(...channel.map(candle => candle.high));
    const channelLow = Math.min(...channel.map(candle => candle.low));
    const channelRange = channelHigh - channelLow;
    const atr = averageTrueRange(candles, 14);
    if (!(atr > 0 && channelRange > 0)) return [];

    const direction: BtcDirection | null = current.close > channelHigh && current.close > current.open ? 'long'
      : current.close < channelLow && current.close < current.open ? 'short' : null;
    if (!direction) return [];
    const volumeRatio = safeDiv(current.volume, median(prior.slice(-32).map(candle => candle.volume)), 0);
    const efficiency = directionalEfficiency(candles, 32);
    const flow = directionalFlow(context, direction);
    const acceptedDistanceAtr = direction === 'long'
      ? safeDiv(current.close - channelHigh, atr, 0)
      : safeDiv(channelLow - current.close, atr, 0);
    if (volumeRatio < 1.12 || efficiency < 0.28 || flow < 1.05 || acceptedDistanceAtr < 0.08) return [];

    const boundary = direction === 'long' ? channelHigh : channelLow;
    const entry = direction === 'long' ? boundary + atr * 0.03 : boundary - atr * 0.03;
    const stop = direction === 'long'
      ? Math.min(boundary - atr * 0.35, current.low - atr * 0.08)
      : Math.max(boundary + atr * 0.35, current.high + atr * 0.08);
    const initialTarget = targetFromRisk(entry, stop, direction, 3.3);
    const extendedTarget = targetFromRisk(entry, stop, direction, 5.5);
    const realisticMove = Math.max(channelRange * 2.5, atr * 16, entry * 0.02);

    return [candidate(context, {
      strategyId: this.id,
      strategyVersion: this.version,
      strategyName: this.name,
      mode: this.mode,
      direction,
      setupType: 'rolling_channel_acceptance',
      entryMethod: 'retest',
      preferredEntry: entry,
      entryZoneLow: direction === 'long' ? boundary : boundary - atr * 0.12,
      entryZoneHigh: direction === 'long' ? boundary + atr * 0.12 : boundary,
      doNotChasePrice: direction === 'long' ? current.close + atr * 0.25 : current.close - atr * 0.25,
      expiresAt: context.timestamp + 75 * 60_000,
      structuralStop: stop,
      initialTarget,
      extendedTarget,
      maximumRealisticTarget: direction === 'long' ? entry + realisticMove : entry - realisticMove,
      strategyLeverageCap: this.leverageCap,
      expectedHoldingMinutes: 360,
      exitModel: 'partial_runner',
      signalScore: 60 + Math.min(18, (volumeRatio - 1) * 28) + efficiency * 18 + Math.max(0, flow - 1) * 14,
      regimeScore: context.regime.direction === 'range' ? 70 : 86,
      executionScore: executionScore(context, 25),
      rationale: [
        `${direction} break of a ${channelLength}-bar rolling channel`,
        `breakout volume ${volumeRatio.toFixed(2)}x baseline`,
        `directional efficiency ${efficiency.toFixed(2)}`,
        `directional flow ratio ${flow.toFixed(2)}`,
      ],
      features: {
        channelLength,
        channelHigh,
        channelLow,
        channelRange,
        volumeRatio,
        efficiency,
        flow,
        acceptedDistanceAtr,
        atr,
      },
    })];
  },
};
