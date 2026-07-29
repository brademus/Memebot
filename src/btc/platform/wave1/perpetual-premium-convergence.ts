import { BtcDirection, StrategyCandidate, StrategyDefinition } from '../types';
import { averageTrueRange, safeDiv, zScore } from '../indicators';
import { candidate, complete, currentPrice, executionScore, observe, priorObservations } from './shared';

export const perpetualPremiumConvergence: StrategyDefinition = {
  id: 'btc-perp-premium-convergence',
  version: '1.0.0',
  name: 'Perpetual-Premium Convergence',
  description: 'Trades medium-duration normalization of an unusually rich or discounted perpetual against consolidated spot fair value.',
  mode: 'actionable',
  leverageCap: 25,
  evaluate(context): StrategyCandidate[] {
    observe(context);
    if (!context.feed.healthy || !context.feed.derivativesHealthy || context.regime.liquidity === 'dislocated') return [];
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
      premiumBps >= 80 && (premiumZ >= 1.7 || premiumBps >= 100)
      && latest.close < latest.open && flow < 1 && (funding >= 0 || premiumBps >= 100)
    ) direction = 'short';
    if (
      premiumBps <= -80 && (premiumZ <= -1.7 || premiumBps <= -100)
      && latest.close > latest.open && flow > 1 && (funding <= 0 || premiumBps <= -100)
    ) direction = 'long';
    if (!direction) return [];

    const entry = currentPrice(context, direction);
    const convergenceDistance = Math.abs(entry - fair);
    if (convergenceDistance <= entry * 0.008) return [];
    const stopDistance = Math.max(entry * 0.00045, Math.min(convergenceDistance / 7.75, atr * 0.2));
    const stop = direction === 'long' ? entry - stopDistance : entry + stopDistance;
    const overshoot = convergenceDistance * 0.3;
    const extendedTarget = direction === 'long' ? fair + overshoot : fair - overshoot;

    return [candidate(context, {
      strategyId: this.id,
      strategyVersion: this.version,
      strategyName: this.name,
      mode: this.mode,
      direction,
      setupType: direction === 'long' ? 'discount_normalization' : 'premium_normalization',
      entryMethod: 'market',
      preferredEntry: entry,
      entryZoneLow: direction === 'long' ? entry - stopDistance * 0.18 : entry - stopDistance * 0.08,
      entryZoneHigh: direction === 'long' ? entry + stopDistance * 0.08 : entry + stopDistance * 0.18,
      doNotChasePrice: direction === 'long' ? entry + stopDistance * 0.5 : entry - stopDistance * 0.5,
      expiresAt: context.timestamp + 15 * 60_000,
      structuralStop: stop,
      initialTarget: fair,
      extendedTarget,
      maximumRealisticTarget: extendedTarget,
      strategyLeverageCap: this.leverageCap,
      expectedHoldingMinutes: 180,
      exitModel: 'fixed',
      signalScore: 60 + Math.min(22, Math.abs(premiumZ) * 7) + Math.min(14, Math.abs(premiumBps) * 0.55),
      regimeScore: context.regime.event === 'normal' ? 88 : 68,
      executionScore: executionScore(context, 32),
      rationale: [
        `perpetual premium ${premiumBps.toFixed(1)} bps at z-score ${premiumZ.toFixed(2)}`,
        `consolidated fair value ${fair.toFixed(2)}`,
        `funding ${(funding * 100).toFixed(4)}%`,
        'price confirmation began moving toward fair value',
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
