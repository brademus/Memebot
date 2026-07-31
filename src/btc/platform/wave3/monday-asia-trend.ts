import { averageTrueRange, directionalEfficiency } from '../indicators';
import { BtcDirection, StrategyCandidate, StrategyDefinition } from '../types';
import { candidate, complete, directionalFlow, executionScore, frictionFloorStop, recentSwing, targetFromRisk, utcDay, utcHour } from './shared';

/**
 * Monday Asia-open trend continuation.
 *
 * Evidence: Concretum/SFI (2018-2025) document a "Monday Asia Open Effect" —
 * high-frequency trend-following returns concentrate from Sunday ~23:00 UTC
 * through Monday, appearing only after 2020H2. This strategy joins an already
 * moving, directionally efficient 1h trend during that window on shallow
 * pullbacks, rather than predicting direction itself.
 */
export const mondayAsiaTrend: StrategyDefinition = {
  id: 'btc-monday-asia-trend',
  version: '0.1.0-shadow',
  name: 'Monday Asia-Open Trend',
  description: 'Researches trend-joining during the documented Sunday-night-through-Monday seasonality window, requiring high 1h directional efficiency and a shallow pullback entry.',
  mode: 'shadow',
  leverageCap: 10,
  evaluate(context): StrategyCandidate[] {
    if (!context.feed.healthy || context.regime.liquidity === 'dislocated') return [];
    const day = utcDay(context.timestamp);
    const hour = utcHour(context.timestamp);
    const inWindow = (day === 0 && hour >= 22) || day === 1;   // Sun 22:00 UTC through Monday
    if (!inWindow) return [];

    const hourly = complete(context.candles.oneHour);
    const fiveMinute = complete(context.candles.fiveMinute);
    if (hourly.length < 16 || fiveMinute.length < 40) return [];
    const efficiency = directionalEfficiency(hourly, 12);
    if (efficiency < 0.55) return [];   // only join a genuinely trending tape
    const trendUp = hourly.at(-1)!.close > hourly.at(-12)!.close;
    const direction: BtcDirection = trendUp ? 'long' : 'short';

    const atr = averageTrueRange(fiveMinute, 20);
    if (!(atr > 0)) return [];
    const last = fiveMinute.at(-1)!;
    const pulledBack = direction === 'long'
      ? last.close < Math.max(...fiveMinute.slice(-6).map(bar => bar.high)) - atr * 0.4 && last.close >= last.open
      : last.close > Math.min(...fiveMinute.slice(-6).map(bar => bar.low)) + atr * 0.4 && last.close <= last.open;
    if (!pulledBack) return [];
    const flow = directionalFlow(context, direction);
    if (flow < 1.02) return [];

    const entry = context.prices.last;
    const rawStop = recentSwing(fiveMinute, direction, 8);
    const stop = frictionFloorStop(entry, rawStop, direction, atr, 1.1);
    const initialTarget = targetFromRisk(entry, stop, direction, 2.5);

    return [candidate(context, {
      strategyId: this.id,
      strategyVersion: this.version,
      strategyName: this.name,
      mode: this.mode,
      direction,
      setupType: direction === 'long' ? 'monday_asia_trend_long' : 'monday_asia_trend_short',
      entryMethod: 'retest',
      preferredEntry: entry,
      entryZoneLow: entry - atr * 0.3,
      entryZoneHigh: entry + atr * 0.3,
      doNotChasePrice: direction === 'long' ? entry + atr * 0.8 : entry - atr * 0.8,
      expiresAt: context.timestamp + 45 * 60_000,
      structuralStop: stop,
      initialTarget,
      extendedTarget: targetFromRisk(entry, stop, direction, 4),
      maximumRealisticTarget: targetFromRisk(entry, stop, direction, 6),
      strategyLeverageCap: this.leverageCap,
      expectedHoldingMinutes: 240,
      exitModel: 'partial_runner',
      signalScore: 58 + Math.min(20, (efficiency - 0.55) * 60) + Math.min(10, (flow - 1) * 25),
      regimeScore: ['bull', 'strong_bull'].includes(context.regime.direction) === (direction === 'long') ? 85 : 62,
      executionScore: executionScore(context),
      rationale: [
        'inside the documented Sunday-night/Monday trend-seasonality window',
        `1h directional efficiency ${efficiency.toFixed(2)} — tape is genuinely trending`,
        `shallow pullback with agreeing flow ${flow.toFixed(2)}`,
      ],
      features: {
        efficiency, flowRatio: flow, atr, utcDay: day, utcHour: hour,
      },
    })];
  },
};
