import { averageTrueRange, rollingVwap, standardDeviation } from '../indicators';
import { BtcDirection, StrategyCandidate, StrategyDefinition } from '../types';
import { candidate, complete, directionalFlow, executionScore, frictionFloorStop, targetFromRisk } from './shared';

/**
 * VWAP disconnect reversion.
 *
 * Rationale: in a ranging regime, a multi-sigma stretch away from the rolling
 * volume-weighted average price with FADING aggressor pressure is the classic
 * exhausted-extension profile — the move ran out of participants, and VWAP is
 * where two-sided business resumes. Strictly regime-gated: never fights a
 * trending tape, never trades extreme volatility.
 */
export const vwapDisconnectReversion: StrategyDefinition = {
  id: 'btc-vwap-disconnect-reversion',
  version: '0.1.0-shadow',
  name: 'VWAP Disconnect Reversion',
  description: 'Researches mean reversion toward rolling VWAP after a multi-sigma stretch in a ranging regime, requiring the aggressor flow behind the stretch to be fading.',
  mode: 'shadow',
  leverageCap: 8,
  evaluate(context): StrategyCandidate[] {
    if (!context.feed.healthy || context.regime.liquidity === 'dislocated') return [];
    if (context.regime.direction !== 'range') return [];
    if (context.regime.volatility === 'extreme') return [];

    const fiveMinute = complete(context.candles.fiveMinute);
    if (fiveMinute.length < 60) return [];
    const vwap = rollingVwap(fiveMinute, 48);   // ~4h of five-minute bars
    if (!(vwap > 0)) return [];
    const closes = fiveMinute.slice(-48).map(bar => bar.close);
    const sigma = standardDeviation(closes);
    if (!(sigma > 0)) return [];

    const price = context.prices.last;
    const stretchSigmas = (price - vwap) / sigma;
    if (Math.abs(stretchSigmas) < 2.2) return [];
    const direction: BtcDirection = stretchSigmas > 0 ? 'short' : 'long';

    // The stretch's own aggressors must be fading: flow AGAINST our direction weak.
    const stretchFlow = directionalFlow(context, direction === 'short' ? 'long' : 'short', 'one');
    if (stretchFlow > 1.0) return [];

    const atr = averageTrueRange(fiveMinute, 20);
    if (!(atr > 0)) return [];
    const extreme = direction === 'short'
      ? Math.max(...fiveMinute.slice(-4).map(bar => bar.high))
      : Math.min(...fiveMinute.slice(-4).map(bar => bar.low));
    const entry = price;
    const stop = frictionFloorStop(entry, extreme, direction, atr);
    const riskDistance = Math.abs(entry - stop);
    const vwapDistance = Math.abs(vwap - entry);
    if (vwapDistance < riskDistance * 2.2) return [];   // reversion must pay at least 2.2R to VWAP

    return [candidate(context, {
      strategyId: this.id,
      strategyVersion: this.version,
      strategyName: this.name,
      mode: this.mode,
      direction,
      setupType: direction === 'short' ? 'vwap_reversion_from_above' : 'vwap_reversion_from_below',
      entryMethod: 'market',
      preferredEntry: entry,
      entryZoneLow: entry - atr * 0.2,
      entryZoneHigh: entry + atr * 0.2,
      doNotChasePrice: direction === 'long' ? entry + atr * 0.5 : entry - atr * 0.5,
      expiresAt: context.timestamp + 25 * 60_000,
      structuralStop: stop,
      initialTarget: vwap,
      extendedTarget: targetFromRisk(entry, stop, direction, 3.4),
      maximumRealisticTarget: targetFromRisk(entry, stop, direction, 4.5),
      strategyLeverageCap: this.leverageCap,
      expectedHoldingMinutes: 150,
      exitModel: 'fixed',
      signalScore: 56 + Math.min(20, (Math.abs(stretchSigmas) - 2.2) * 14) + Math.min(12, (1 - stretchFlow) * 30),
      regimeScore: 84,
      executionScore: executionScore(context),
      rationale: [
        `price stretched ${stretchSigmas.toFixed(1)} sigma from 4h rolling VWAP in a ranging regime`,
        `stretch-side aggressor flow faded to ${stretchFlow.toFixed(2)} — extension out of participants`,
        `reversion to VWAP pays ${(vwapDistance / riskDistance).toFixed(1)}R against the floored stop`,
      ],
      features: {
        vwap, sigma, stretchSigmas, stretchFlow, atr,
        vwapDistance, riskDistance,
      },
    })];
  },
};
