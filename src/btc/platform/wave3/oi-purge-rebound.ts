import { averageTrueRange } from '../indicators';
import { StrategyCandidate, StrategyDefinition } from '../types';
import { candidate, complete, directionalFlow, executionScore, frictionFloorStop, targetFromRisk } from './shared';

/**
 * Open-interest purge stabilization rebound.
 *
 * Evidence: post-flush dynamics are well documented — a sharp OI drop removes
 * the forced-selling fuel, and "wait for liquidation volume to peak" is the
 * practitioner rule separating survivors from knife-catchers. Distinct from
 * the wave-2 cascade-exhaustion strategy (which trades the capitulation
 * climax itself): this one requires the purge to be FINISHED — liquidation
 * flow decayed, a higher low printed — and longs the leverage-rebuild phase.
 */
export const oiPurgeRebound: StrategyDefinition = {
  id: 'btc-oi-purge-rebound',
  version: '0.1.0-shadow',
  name: 'OI-Purge Stabilization Rebound',
  description: 'Researches longs after a sharp open-interest purge once liquidation flow has decayed and a higher low confirms stabilization — the post-flush rebuild, not the falling knife.',
  mode: 'shadow',
  leverageCap: 8,
  evaluate(context): StrategyCandidate[] {
    if (!context.feed.healthy || context.regime.liquidity === 'dislocated') return [];
    if (context.regime.event === 'liquidation_cascade') return [];   // still raining chainsaws
    if (context.derivatives.openInterestChangePct > -3) return [];   // no meaningful purge

    const longLiq = context.derivatives.longLiquidationUsd5m;
    const shortLiq = context.derivatives.shortLiquidationUsd5m;
    if (longLiq > 400_000) return [];   // forced selling has not decayed yet
    if (longLiq < shortLiq) return [];  // this was not a long purge

    const fiveMinute = complete(context.candles.fiveMinute);
    if (fiveMinute.length < 40) return [];
    const recent = fiveMinute.slice(-8);
    const purgeLowIndex = recent.reduce((lowest, bar, index) => bar.low < recent[lowest].low ? index : lowest, 0);
    if (purgeLowIndex >= recent.length - 2) return [];   // the low is too fresh — no stabilization yet
    const purgeLow = recent[purgeLowIndex].low;
    const afterLow = recent.slice(purgeLowIndex + 1);
    const higherLow = Math.min(...afterLow.map(bar => bar.low));
    if (!(higherLow > purgeLow)) return [];
    const last = recent.at(-1)!;
    if (!(last.close > last.open)) return [];

    const atr = averageTrueRange(fiveMinute, 20);
    if (!(atr > 0)) return [];
    const flow = directionalFlow(context, 'long');
    if (flow < 1.05) return [];

    const entry = context.prices.last;
    const stop = frictionFloorStop(entry, purgeLow, 'long', atr);
    const initialTarget = targetFromRisk(entry, stop, 'long', 2.6);

    return [candidate(context, {
      strategyId: this.id,
      strategyVersion: this.version,
      strategyName: this.name,
      mode: this.mode,
      direction: 'long',
      setupType: 'oi_purge_stabilization_long',
      entryMethod: 'market',
      preferredEntry: entry,
      entryZoneLow: entry - atr * 0.3,
      entryZoneHigh: entry + atr * 0.2,
      doNotChasePrice: entry + atr * 0.8,
      expiresAt: context.timestamp + 30 * 60_000,
      structuralStop: stop,
      initialTarget,
      extendedTarget: targetFromRisk(entry, stop, 'long', 4),
      maximumRealisticTarget: targetFromRisk(entry, stop, 'long', 6),
      strategyLeverageCap: this.leverageCap,
      expectedHoldingMinutes: 180,
      exitModel: 'partial_runner',
      signalScore: 58 + Math.min(16, Math.abs(context.derivatives.openInterestChangePct) * 2) + Math.min(12, (flow - 1.05) * 30),
      regimeScore: context.regime.positioning === 'deleveraging' ? 86 : 70,
      executionScore: executionScore(context),
      rationale: [
        `open interest purged ${context.derivatives.openInterestChangePct.toFixed(1)}% — forced-selling fuel removed`,
        `long liquidations decayed to $${Math.round(longLiq / 1_000)}k/5m and a higher low printed above ${purgeLow.toFixed(0)}`,
        `rebuild flow ${flow.toFixed(2)} — entering the repositioning phase, not the knife`,
      ],
      features: {
        oiChangePct: context.derivatives.openInterestChangePct,
        longLiqUsd5m: longLiq, shortLiqUsd5m: shortLiq,
        purgeLow, higherLow, flowRatio: flow, atr,
      },
    })];
  },
};
