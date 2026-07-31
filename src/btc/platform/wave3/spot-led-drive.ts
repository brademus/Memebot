import { averageTrueRange } from '../indicators';
import { BtcDirection, StrategyCandidate, StrategyDefinition } from '../types';
import { candidate, complete, directionalFlow, executionScore, frictionFloorStop, recentSwing, targetFromRisk } from './shared';

/**
 * Spot-led drive continuation.
 *
 * Rationale: the two-tier structure of crypto price discovery means the
 * healthiest directional moves are led by SPOT (index) with the perp premium
 * compressed — real demand, not leverage froth. A rising tape where basis
 * stays near or below zero and open interest is NOT ballooning is spot
 * accumulation; those moves continue more reliably than premium-stretched,
 * leverage-driven pushes (which the wave-1 premium-convergence strategy
 * fades). This is the constructive mirror of that fade.
 */
export const spotLedDrive: StrategyDefinition = {
  id: 'btc-spot-led-drive',
  version: '0.1.0-shadow',
  name: 'Spot-Led Drive Continuation',
  description: 'Researches trend continuation when the move is led by spot: directional 15m drive with compressed perp basis and restrained open-interest growth.',
  mode: 'shadow',
  leverageCap: 12,
  evaluate(context): StrategyCandidate[] {
    if (!context.feed.healthy || context.regime.liquidity === 'dislocated') return [];
    const fifteen = complete(context.candles.fifteenMinute);
    const fiveMinute = complete(context.candles.fiveMinute);
    if (fifteen.length < 10 || fiveMinute.length < 40) return [];

    const drivePct = (fifteen.at(-1)!.close - fifteen.at(-4)!.close) / fifteen.at(-4)!.close * 100;
    if (Math.abs(drivePct) < 0.35) return [];
    const direction: BtcDirection = drivePct > 0 ? 'long' : 'short';

    const basis = context.derivatives.basisBps;
    const spotLed = direction === 'long' ? basis <= 4 : basis >= -4;
    if (!spotLed) return [];   // premium stretched with the move = leverage-led, not our trade
    const oiRestrained = Math.abs(context.derivatives.openInterestChangePct) < 1.5;
    if (!oiRestrained) return [];
    const flow = directionalFlow(context, direction);
    if (flow < 1.05) return [];

    const atr = averageTrueRange(fiveMinute, 20);
    if (!(atr > 0)) return [];
    const entry = context.prices.last;
    const rawStop = recentSwing(fiveMinute, direction, 10);
    const stop = frictionFloorStop(entry, rawStop, direction, atr, 1.1);
    const initialTarget = targetFromRisk(entry, stop, direction, 2.8);

    return [candidate(context, {
      strategyId: this.id,
      strategyVersion: this.version,
      strategyName: this.name,
      mode: this.mode,
      direction,
      setupType: direction === 'long' ? 'spot_led_drive_long' : 'spot_led_drive_short',
      entryMethod: 'retest',
      preferredEntry: entry,
      entryZoneLow: entry - atr * 0.35,
      entryZoneHigh: entry + atr * 0.35,
      doNotChasePrice: direction === 'long' ? entry + atr * 0.9 : entry - atr * 0.9,
      expiresAt: context.timestamp + 40 * 60_000,
      structuralStop: stop,
      initialTarget,
      extendedTarget: targetFromRisk(entry, stop, direction, 4.5),
      maximumRealisticTarget: targetFromRisk(entry, stop, direction, 6.5),
      strategyLeverageCap: this.leverageCap,
      expectedHoldingMinutes: 200,
      exitModel: 'partial_runner',
      signalScore: 58 + Math.min(16, Math.abs(drivePct) * 18) + Math.min(12, (flow - 1.05) * 30),
      regimeScore: ['bull', 'strong_bull'].includes(context.regime.direction) === (direction === 'long') ? 86 : 64,
      executionScore: executionScore(context),
      rationale: [
        `15m drive of ${drivePct.toFixed(2)}% with basis at ${basis.toFixed(1)}bps — spot leading, not leverage`,
        `open interest restrained (${context.derivatives.openInterestChangePct.toFixed(2)}%) — no froth to unwind`,
        `flow ${flow.toFixed(2)} agrees with continuation`,
      ],
      features: {
        drivePct, basisBps: basis,
        oiChangePct: context.derivatives.openInterestChangePct,
        flowRatio: flow, atr,
      },
    })];
  },
};
