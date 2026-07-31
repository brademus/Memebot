import { averageTrueRange } from '../indicators';
import { BtcDirection, StrategyCandidate, StrategyDefinition } from '../types';
import { candidate, complete, directionalFlow, executionScore, frictionFloorStop, roundLevelContext, targetFromRisk } from './shared';

/**
 * Round-level first-touch rejection.
 *
 * Rationale: $1,000 round levels in BTC cluster resting orders, option strike
 * hedging, and psychological stops — the classic anchoring microstructure. A
 * FIRST approach to a fresh round level that stalls with opposing aggressor
 * flow and visible absorption tends to reject on that first attempt (repeated
 * attempts weaken the level, so only the first touch qualifies).
 */
export const roundLevelRejection: StrategyDefinition = {
  id: 'btc-round-level-rejection',
  version: '0.1.0-shadow',
  name: 'Round-Level First-Touch Rejection',
  description: 'Researches fading the first touch of a fresh $1,000 round level when the approach stalls with opposing flow and order-book absorption.',
  mode: 'shadow',
  leverageCap: 8,
  evaluate(context): StrategyCandidate[] {
    if (!context.feed.healthy || context.regime.liquidity === 'dislocated') return [];
    if (context.regime.volatility === 'extreme') return [];
    const price = context.prices.last;
    const { level, distanceFraction } = roundLevelContext(price);
    if (distanceFraction > 0.0015) return [];   // within 0.15% of the level

    const fiveMinute = complete(context.candles.fiveMinute);
    if (fiveMinute.length < 60) return [];
    // First touch: none of the prior ~4h came within 0.2% of this level.
    const previously = fiveMinute.slice(-48, -2);
    const touchedBefore = previously.some(bar => bar.high >= level * 0.998 && bar.low <= level * 1.002);
    if (touchedBefore) return [];

    const approach = fiveMinute.slice(-3);
    const approachingFromBelow = approach[0].close < level && price >= approach[0].close;
    const approachingFromAbove = approach[0].close > level && price <= approach[0].close;
    const direction: BtcDirection | null = approachingFromBelow ? 'short' : approachingFromAbove ? 'long' : null;
    if (!direction) return [];

    const flow = directionalFlow(context, direction, 'one');
    if (flow < 1.15) return [];   // rejection-side aggressors already winning at the level
    if (context.orderFlow.absorptionScore < 0.55) return [];

    const atr = averageTrueRange(fiveMinute, 20);
    if (!(atr > 0)) return [];
    const entry = price;
    const beyond = direction === 'short' ? level + atr * 0.35 : level - atr * 0.35;
    const stop = frictionFloorStop(entry, beyond, direction, atr);
    const initialTarget = targetFromRisk(entry, stop, direction, 2.4);

    return [candidate(context, {
      strategyId: this.id,
      strategyVersion: this.version,
      strategyName: this.name,
      mode: this.mode,
      direction,
      setupType: direction === 'short' ? 'round_level_rejection_short' : 'round_level_rejection_long',
      entryMethod: 'market',
      preferredEntry: entry,
      entryZoneLow: entry - atr * 0.2,
      entryZoneHigh: entry + atr * 0.2,
      doNotChasePrice: direction === 'long' ? entry + atr * 0.5 : entry - atr * 0.5,
      expiresAt: context.timestamp + 20 * 60_000,
      structuralStop: stop,
      initialTarget,
      extendedTarget: targetFromRisk(entry, stop, direction, 3.6),
      maximumRealisticTarget: targetFromRisk(entry, stop, direction, 5),
      strategyLeverageCap: this.leverageCap,
      expectedHoldingMinutes: 100,
      exitModel: 'fixed',
      signalScore: 55 + Math.min(15, (flow - 1.15) * 25) + Math.min(15, context.orderFlow.absorptionScore * 20),
      regimeScore: context.regime.direction === 'range' ? 82 : 66,
      executionScore: executionScore(context),
      rationale: [
        `first touch of the $${level.toLocaleString()} round level in ~4 hours`,
        `rejection-side flow ${flow.toFixed(2)} with absorption score ${context.orderFlow.absorptionScore.toFixed(2)}`,
        'fading the first attempt only — repeated tests void the setup',
      ],
      features: {
        level, distanceFraction, flowRatio: flow,
        absorptionScore: context.orderFlow.absorptionScore, atr,
      },
    })];
  },
};
