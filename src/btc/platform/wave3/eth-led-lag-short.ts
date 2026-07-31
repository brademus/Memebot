import { averageTrueRange } from '../indicators';
import { StrategyCandidate, StrategyDefinition } from '../types';
import { candidate, complete, directionalFlow, executionScore, frictionFloorStop, targetFromRisk } from './shared';

/**
 * ETH-led lag short.
 *
 * Rationale: cross-asset lead-lag runs both directions, but the existing
 * wave-2 catch-up strategy only trades the bullish case (ETH leads up, BTC
 * catches up). The bearish mirror is untested: ETH selling off hard while BTC
 * lags flat tends to resolve with BTC converging down once BTC's own tape
 * cracks — risk sentiment is shared, and the lag is opportunity, not
 * immunity. Requires BTC's own breakdown confirmation; never shorts a lag
 * that BTC is absorbing with strength.
 */
export const ethLedLagShort: StrategyDefinition = {
  id: 'btc-eth-led-lag-short',
  version: '0.1.0-shadow',
  name: 'ETH-Led Lag Short',
  description: 'Researches shorting BTC when ETH leads sharply lower, BTC lags, and BTC then prints its own breakdown confirmation — the bearish mirror of the catch-up strategy.',
  mode: 'shadow',
  leverageCap: 8,
  evaluate(context): StrategyCandidate[] {
    if (!context.feed.healthy || context.regime.liquidity === 'dislocated') return [];
    const cross = context.crossAsset;
    if (!cross?.healthy) return [];
    const ethMove = cross.ethReturn15mPct;
    const relative = cross.relativeReturn15mPct;
    if (ethMove === null || relative === null) return [];
    if (ethMove > -0.6) return [];       // ETH must be leading meaningfully lower
    if (relative < 0.35) return [];      // and BTC must actually be lagging it

    const fiveMinute = complete(context.candles.fiveMinute);
    if (fiveMinute.length < 40) return [];
    const last = fiveMinute.at(-1)!;
    const prior = fiveMinute.at(-2)!;
    const breakdown = last.close < prior.low && last.close < last.open;
    if (!breakdown) return [];   // BTC's own tape must crack; no shorting strength
    const flow = directionalFlow(context, 'short');
    if (flow < 1.1) return [];

    const atr = averageTrueRange(fiveMinute, 20);
    if (!(atr > 0)) return [];
    const entry = context.prices.last;
    const swingHigh = Math.max(...fiveMinute.slice(-6).map(bar => bar.high));
    const stop = frictionFloorStop(entry, swingHigh, 'short', atr);
    const initialTarget = targetFromRisk(entry, stop, 'short', 2.5);

    return [candidate(context, {
      strategyId: this.id,
      strategyVersion: this.version,
      strategyName: this.name,
      mode: this.mode,
      direction: 'short',
      setupType: 'eth_led_lag_short',
      entryMethod: 'market',
      preferredEntry: entry,
      entryZoneLow: entry - atr * 0.2,
      entryZoneHigh: entry + atr * 0.3,
      doNotChasePrice: entry - atr * 0.7,
      expiresAt: context.timestamp + 25 * 60_000,
      structuralStop: stop,
      initialTarget,
      extendedTarget: targetFromRisk(entry, stop, 'short', 4),
      maximumRealisticTarget: targetFromRisk(entry, stop, 'short', 5.5),
      strategyLeverageCap: this.leverageCap,
      expectedHoldingMinutes: 120,
      exitModel: 'partial_runner',
      signalScore: 56 + Math.min(16, Math.abs(ethMove) * 8) + Math.min(14, relative * 12) + Math.min(8, (flow - 1.1) * 20),
      regimeScore: ['bear', 'strong_bear'].includes(context.regime.direction) ? 86 : 66,
      executionScore: executionScore(context),
      rationale: [
        `ETH led ${ethMove.toFixed(2)}% lower over 15m while BTC lagged by ${relative.toFixed(2)}%`,
        'BTC printed its own breakdown bar — convergence, not hope, is the trigger',
        `sell flow ${flow.toFixed(2)} confirms`,
      ],
      features: {
        ethReturn15mPct: ethMove, relativeReturn15mPct: relative,
        flowRatio: flow, atr,
      },
    })];
  },
};
