import { BtcDirection, StrategyCandidate, StrategyDefinition } from '../types';
import { averageTrueRange, safeDiv, zScore } from '../indicators';
import { candidate, complete, currentPrice, executionScore, observe, priorObservations } from './shared';

export const perpetualPremiumConvergence: StrategyDefinition = {
  id: 'btc-perp-premium-convergence',
  version: '2.0.0',
  name: 'Friction-Aware Perpetual-Premium Convergence',
  description: 'Trades only unusually large perpetual dislocations whose distance to consolidated fair value remains viable after fees, slippage and structural risk.',
  mode: 'actionable',
  leverageCap: 12,
  evaluate(context): StrategyCandidate[] {
    observe(context);
    if (!context.feed.healthy || !context.feed.derivativesHealthy
      || !['deep', 'normal'].includes(context.regime.liquidity)
      || context.regime.event !== 'normal' || context.orderFlow.bookFragility > 0.35) return [];
    const candles = complete(context.candles.fiveMinute);
    if (candles.length < 24) return [];
    const latest = candles.at(-1)!;
    const atr = averageTrueRange(candles, 14);
    const fair = context.prices.consolidatedFair;
    const mark = context.prices.mark;
    if (!(atr > 0 && fair > 0 && mark > 0)) return [];

    const premiumBps = safeDiv(mark - fair, fair) * 10_000;
    const baseline = priorObservations(144);
    const premiumZ = baseline.length >= 12
      ? zScore(baseline.map(item => item.premiumBps), premiumBps)
      : safeDiv(premiumBps, 5, 0);
    const flow = safeDiv(context.orderFlow.aggressiveBuyUsd5m, context.orderFlow.aggressiveSellUsd5m, 1);
    const funding = context.derivatives.fundingRate;

    let direction: BtcDirection | null = null;
    if (
      premiumBps >= 150 && (premiumZ >= 2 || premiumBps >= 180)
      && latest.close < latest.open && flow < 1 && funding >= 0
    ) direction = 'short';
    if (
      premiumBps <= -150 && (premiumZ <= -2 || premiumBps <= -180)
      && latest.close > latest.open && flow > 1 && funding <= 0
    ) direction = 'long';
    if (!direction) return [];

    const entry = currentPrice(context, direction);
    const convergenceDistance = Math.abs(entry - fair);
    if (convergenceDistance <= entry * 0.0145) return [];

    // The old 4.5 bps stop was smaller than modeled round-trip friction. A
    // convergence trade now gives the dislocation room to widen while keeping
    // the stop below roughly one third of the distance back to fair value.
    const stopDistance = Math.max(
      entry * 0.0045,
      Math.min(convergenceDistance / 3.5, atr * 1.5),
    );
    if (stopDistance >= convergenceDistance / 2.5) return [];
    const stop = direction === 'long' ? entry - stopDistance : entry + stopDistance;
    const overshoot = convergenceDistance * 0.2;
    const extendedTarget = direction === 'long' ? fair + overshoot : fair - overshoot;

    return [candidate(context, {
      strategyId: this.id,
      strategyVersion: this.version,
      strategyName: this.name,
      mode: this.mode,
      direction,
      setupType: direction === 'long' ? 'deep_discount_normalization' : 'deep_premium_normalization',
      entryMethod: 'market',
      preferredEntry: entry,
      entryZoneLow: direction === 'long' ? entry - stopDistance * 0.12 : entry - stopDistance * 0.05,
      entryZoneHigh: direction === 'long' ? entry + stopDistance * 0.05 : entry + stopDistance * 0.12,
      doNotChasePrice: direction === 'long' ? entry + stopDistance * 0.35 : entry - stopDistance * 0.35,
      expiresAt: context.timestamp + 10 * 60_000,
      structuralStop: stop,
      initialTarget: fair,
      extendedTarget,
      maximumRealisticTarget: extendedTarget,
      strategyLeverageCap: this.leverageCap,
      expectedHoldingMinutes: 240,
      exitModel: 'fixed',
      signalScore: 66 + Math.min(20, Math.abs(premiumZ) * 6) + Math.min(14, (Math.abs(premiumBps) - 150) * 0.18),
      regimeScore: 90,
      executionScore: executionScore(context, 36),
      rationale: [
        `perpetual dislocation ${premiumBps.toFixed(1)} bps at z-score ${premiumZ.toFixed(2)}`,
        `consolidated fair value ${fair.toFixed(2)}`,
        `structural stop is ${(stopDistance / entry * 10_000).toFixed(1)} bps versus ${(convergenceDistance / entry * 10_000).toFixed(1)} bps to fair`,
        `funding ${(funding * 100).toFixed(4)}% and price confirmation align toward convergence`,
      ],
      features: {
        premiumBps,
        premiumZ,
        fair,
        mark,
        convergenceDistance,
        stopDistance,
        funding,
        flow,
        baselineCount: baseline.length,
        atr,
      },
    })];
  },
};
