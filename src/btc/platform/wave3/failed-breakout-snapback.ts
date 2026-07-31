import { averageTrueRange } from '../indicators';
import { BtcDirection, StrategyCandidate, StrategyDefinition } from '../types';
import { candidate, complete, directionalFlow, executionScore, frictionFloorStop, targetFromRisk } from './shared';

/**
 * Failed-breakout snapback.
 *
 * Evidence: the OI rule again, from the other side — a breakout on falling
 * open interest is a liquidity grab and tends to mean-revert. This researches
 * the structural version on 15m bars: a close beyond a multi-hour extreme
 * that closes back INSIDE within two bars, with OI flat-to-falling through
 * the attempt, snaps back toward the opposite side of the broken range.
 * Distinct from the wave-1 liquidity-sweep reversal, which hunts fast
 * wick-level sweeps intrabar; this requires full 15m closes out and back in.
 */
export const failedBreakoutSnapback: StrategyDefinition = {
  id: 'btc-failed-breakout-snapback',
  version: '0.1.0-shadow',
  name: 'Failed-Breakout Snapback',
  description: 'Researches reversal after a 15m close beyond a multi-hour extreme fails back inside within two bars on flat-to-falling open interest.',
  mode: 'shadow',
  leverageCap: 8,
  evaluate(context): StrategyCandidate[] {
    if (!context.feed.healthy || context.regime.liquidity === 'dislocated') return [];
    const fifteen = complete(context.candles.fifteenMinute);
    const fiveMinute = complete(context.candles.fiveMinute);
    if (fifteen.length < 30 || fiveMinute.length < 40) return [];

    const reference = fifteen.slice(-26, -3);   // the multi-hour structure before the attempt
    const attemptBars = fifteen.slice(-3);
    const refHigh = Math.max(...reference.map(bar => bar.high));
    const refLow = Math.min(...reference.map(bar => bar.low));
    const last = attemptBars.at(-1)!;

    const brokeUp = attemptBars.slice(0, -1).some(bar => bar.close > refHigh);
    const brokeDown = attemptBars.slice(0, -1).some(bar => bar.close < refLow);
    const failedUp = brokeUp && last.close < refHigh;
    const failedDown = brokeDown && last.close > refLow;
    const direction: BtcDirection | null = failedUp ? 'short' : failedDown ? 'long' : null;
    if (!direction) return [];
    if (context.derivatives.openInterestChangePct > 0.1) return [];   // real positioning joined — not a grab

    const flow = directionalFlow(context, direction);
    if (flow < 1.08) return [];
    const atr = averageTrueRange(fiveMinute, 20);
    if (!(atr > 0)) return [];

    const entry = context.prices.last;
    const attemptExtreme = direction === 'short'
      ? Math.max(...attemptBars.map(bar => bar.high))
      : Math.min(...attemptBars.map(bar => bar.low));
    const stop = frictionFloorStop(entry, attemptExtreme, direction, atr);
    const rangeMid = (refHigh + refLow) / 2;
    const initialTarget = targetFromRisk(entry, stop, direction, 2.4);

    return [candidate(context, {
      strategyId: this.id,
      strategyVersion: this.version,
      strategyName: this.name,
      mode: this.mode,
      direction,
      setupType: direction === 'short' ? 'failed_upside_breakout' : 'failed_downside_breakout',
      entryMethod: 'market',
      preferredEntry: entry,
      entryZoneLow: entry - atr * 0.25,
      entryZoneHigh: entry + atr * 0.25,
      doNotChasePrice: direction === 'long' ? entry + atr * 0.6 : entry - atr * 0.6,
      expiresAt: context.timestamp + 30 * 60_000,
      structuralStop: stop,
      initialTarget,
      extendedTarget: direction === 'short' ? Math.min(rangeMid, targetFromRisk(entry, stop, direction, 3.6))
        : Math.max(rangeMid, targetFromRisk(entry, stop, direction, 3.6)),
      maximumRealisticTarget: direction === 'short' ? refLow : refHigh,
      strategyLeverageCap: this.leverageCap,
      expectedHoldingMinutes: 180,
      exitModel: 'partial_runner',
      signalScore: 56 + Math.min(14, (flow - 1.08) * 30) + Math.min(14, Math.max(0, -context.derivatives.openInterestChangePct) * 10),
      regimeScore: context.regime.direction === 'range' ? 84 : 68,
      executionScore: executionScore(context),
      rationale: [
        `15m close beyond the multi-hour ${direction === 'short' ? 'high' : 'low'} failed back inside within two bars`,
        `open interest ${context.derivatives.openInterestChangePct.toFixed(2)}% through the attempt — a grab, not positioning`,
        `snapback flow ${flow.toFixed(2)} toward the opposite side of the broken range`,
      ],
      features: {
        refHigh, refLow, attemptExtreme, rangeMid,
        oiChangePct: context.derivatives.openInterestChangePct,
        flowRatio: flow, atr,
      },
    })];
  },
};
