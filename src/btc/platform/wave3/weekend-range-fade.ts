import { averageTrueRange, rangePosition } from '../indicators';
import { BtcDirection, StrategyCandidate, StrategyDefinition } from '../types';
import { candidate, complete, directionalFlow, executionScore, frictionFloorStop, isWeekendUtc, targetFromRisk } from './shared';

/**
 * Weekend thin-liquidity range fade.
 *
 * Evidence: weekend BTC volume and volatility run well below weekday levels
 * (documented across venues), and a range-edge push on FALLING open interest
 * is the liquidity-grab signature — nobody new is positioning; resting stops
 * are being harvested in a thin book. Fades those pushes back inside the
 * weekend range. Strictly weekend-only, range-regime-only.
 */
export const weekendRangeFade: StrategyDefinition = {
  id: 'btc-weekend-range-fade',
  version: '0.1.0-shadow',
  name: 'Weekend Range Fade',
  description: 'Researches fading weekend range-extreme pushes that occur on falling open interest in a thin, ranging tape — the liquidity-grab profile.',
  mode: 'shadow',
  leverageCap: 8,
  evaluate(context): StrategyCandidate[] {
    if (!context.feed.healthy || context.regime.liquidity === 'dislocated') return [];
    if (!isWeekendUtc(context.timestamp)) return [];
    if (context.regime.direction !== 'range') return [];
    if (context.regime.volatility === 'extreme' || context.regime.volatility === 'elevated') return [];

    const fifteen = complete(context.candles.fifteenMinute);
    const fiveMinute = complete(context.candles.fiveMinute);
    if (fifteen.length < 24 || fiveMinute.length < 40) return [];
    const price = context.prices.last;
    const position = rangePosition(fifteen, 24, price);   // 0 = 6h low, 1 = 6h high
    const direction: BtcDirection | null = position >= 0.94 ? 'short' : position <= 0.06 ? 'long' : null;
    if (!direction) return [];

    if (context.derivatives.openInterestChangePct > -0.2) return [];   // grab requires falling OI
    const flow = directionalFlow(context, direction, 'one');
    if (flow < 1.05) return [];   // fade-side aggressors already turning it

    const atr = averageTrueRange(fiveMinute, 20);
    if (!(atr > 0)) return [];
    const entry = price;
    const extreme = direction === 'short'
      ? Math.max(...fifteen.slice(-24).map(bar => bar.high))
      : Math.min(...fifteen.slice(-24).map(bar => bar.low));
    const stop = frictionFloorStop(entry, direction === 'short' ? extreme + atr * 0.2 : extreme - atr * 0.2, direction, atr);
    const initialTarget = targetFromRisk(entry, stop, direction, 2.3);

    return [candidate(context, {
      strategyId: this.id,
      strategyVersion: this.version,
      strategyName: this.name,
      mode: this.mode,
      direction,
      setupType: direction === 'short' ? 'weekend_high_fade' : 'weekend_low_fade',
      entryMethod: 'market',
      preferredEntry: entry,
      entryZoneLow: entry - atr * 0.25,
      entryZoneHigh: entry + atr * 0.25,
      doNotChasePrice: direction === 'long' ? entry + atr * 0.6 : entry - atr * 0.6,
      expiresAt: context.timestamp + 30 * 60_000,
      structuralStop: stop,
      initialTarget,
      extendedTarget: targetFromRisk(entry, stop, direction, 3.5),
      maximumRealisticTarget: targetFromRisk(entry, stop, direction, 4.5),
      strategyLeverageCap: this.leverageCap,
      expectedHoldingMinutes: 160,
      exitModel: 'fixed',
      signalScore: 54 + Math.min(14, Math.abs(context.derivatives.openInterestChangePct) * 12) + Math.min(14, (flow - 1.05) * 30),
      regimeScore: 80,
      executionScore: executionScore(context, 34),   // thin books penalized harder
      rationale: [
        `weekend range extreme (position ${(position * 100).toFixed(0)}% of the 6h range) in a thin tape`,
        `push ran on falling open interest (${context.derivatives.openInterestChangePct.toFixed(2)}%) — grab, not positioning`,
        `fade-side flow ${flow.toFixed(2)} already turning it back inside`,
      ],
      features: {
        rangePosition: position,
        oiChangePct: context.derivatives.openInterestChangePct,
        flowRatio: flow, atr, extreme,
      },
    })];
  },
};
