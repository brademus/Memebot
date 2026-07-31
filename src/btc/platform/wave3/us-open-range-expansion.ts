import { averageTrueRange } from '../indicators';
import { BtcDirection, StrategyCandidate, StrategyDefinition } from '../types';
import { candidate, complete, directionalFlow, executionScore, frictionFloorStop, targetFromRisk, utcHour } from './shared';

/**
 * US equity-open range expansion.
 *
 * Evidence: BTC volume/volatility peak in the 14:00-15:00 GMT hour, driven by
 * US equity-market spillover (Deribit options study 2017-2025; Bitstamp
 * volume/vol studies), and the practitioner rule that a breakout on RISING
 * open interest is structurally sound while one on falling OI is a liquidity
 * grab. This strategy trades the first sustained break of the 13:30-13:45 UTC
 * opening range during the high-participation window, only with OI expanding
 * and aggressor flow agreeing.
 */
export const usOpenRangeExpansion: StrategyDefinition = {
  id: 'btc-us-open-range-expansion',
  version: '0.1.0-shadow',
  name: 'US-Open Range Expansion',
  description: 'Researches breakouts of the 13:30-13:45 UTC opening range during the US-open volatility window, requiring rising open interest and agreeing aggressor flow.',
  mode: 'shadow',
  leverageCap: 10,
  evaluate(context): StrategyCandidate[] {
    if (!context.feed.healthy || context.regime.liquidity === 'dislocated') return [];
    const hour = utcHour(context.timestamp);
    if (hour < 13 || hour > 15) return [];
    const minutes = new Date(context.timestamp).getUTCMinutes();
    if (hour === 13 && minutes < 48) return [];   // opening range still forming
    const oneMinute = complete(context.candles.oneMinute);
    if (oneMinute.length < 60) return [];

    const dayStart = new Date(context.timestamp).setUTCHours(13, 30, 0, 0);
    const rangeBars = oneMinute.filter(bar => bar.startMs >= dayStart && bar.startMs < dayStart + 15 * 60_000);
    if (rangeBars.length < 12) return [];
    const rangeHigh = Math.max(...rangeBars.map(bar => bar.high));
    const rangeLow = Math.min(...rangeBars.map(bar => bar.low));
    const rangeSize = rangeHigh - rangeLow;
    if (!(rangeSize > 0)) return [];

    const price = context.prices.last;
    const direction: BtcDirection | null = price > rangeHigh ? 'long' : price < rangeLow ? 'short' : null;
    if (!direction) return [];
    const breakDistance = direction === 'long' ? price - rangeHigh : rangeLow - price;
    const fiveMinute = complete(context.candles.fiveMinute);
    if (fiveMinute.length < 30) return [];
    const atr = averageTrueRange(fiveMinute, 20);
    if (!(atr > 0) || breakDistance > atr * 1.2) return [];   // do not chase an extended break

    const oiExpanding = context.derivatives.openInterestChangePct > 0.15;
    if (!oiExpanding) return [];   // falling-OI breaks are liquidity grabs, not expansion
    const flow = directionalFlow(context, direction);
    if (flow < 1.12) return [];

    const entry = price;
    const rawStop = direction === 'long' ? rangeLow : rangeHigh;
    const stop = frictionFloorStop(entry, rawStop, direction, atr);
    const initialTarget = targetFromRisk(entry, stop, direction, 2.6);
    const extendedTarget = targetFromRisk(entry, stop, direction, 4.2);

    return [candidate(context, {
      strategyId: this.id,
      strategyVersion: this.version,
      strategyName: this.name,
      mode: this.mode,
      direction,
      setupType: direction === 'long' ? 'us_open_upside_expansion' : 'us_open_downside_expansion',
      entryMethod: 'market',
      preferredEntry: entry,
      entryZoneLow: direction === 'long' ? entry - atr * 0.25 : entry - atr * 0.1,
      entryZoneHigh: direction === 'long' ? entry + atr * 0.1 : entry + atr * 0.25,
      doNotChasePrice: direction === 'long' ? entry + atr * 0.6 : entry - atr * 0.6,
      expiresAt: context.timestamp + 25 * 60_000,
      structuralStop: stop,
      initialTarget,
      extendedTarget,
      maximumRealisticTarget: targetFromRisk(entry, stop, direction, 6),
      strategyLeverageCap: this.leverageCap,
      expectedHoldingMinutes: 120,
      exitModel: 'partial_runner',
      signalScore: 62 + Math.min(12, (flow - 1.12) * 30) + Math.min(12, context.derivatives.openInterestChangePct * 8),
      regimeScore: context.regime.volatility === 'compressed' ? 60 : 82,
      executionScore: executionScore(context),
      rationale: [
        `US-open window break of the 13:30-13:45 UTC range (${rangeLow.toFixed(0)}-${rangeHigh.toFixed(0)})`,
        `open interest expanding ${context.derivatives.openInterestChangePct.toFixed(2)}% — leverage joining, not a grab`,
        `aggressor flow ratio ${flow.toFixed(2)} agrees with the break`,
      ],
      features: {
        rangeHigh, rangeLow, rangeSize, breakDistance, atr,
        oiChangePct: context.derivatives.openInterestChangePct,
        flowRatio: flow,
        utcHour: hour,
      },
    })];
  },
};
