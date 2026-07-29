import { BtcDirection, StrategyCandidate, StrategyDefinition } from '../types';
import { averageTrueRange, pct, safeDiv, zScore } from '../indicators';
import { candidate, complete, currentPrice, directionalFlow, executionScore, observe, priorObservations, recentSwing, targetFromRisk } from './shared';

export const fundingCrowdingReversal: StrategyDefinition = {
  id: 'btc-funding-crowding-reversal',
  version: '1.0.0',
  name: 'Funding Crowding Reversal',
  description: 'Fades statistically extreme funding only after crowded positioning stops producing directional price progress.',
  mode: 'actionable',
  leverageCap: 18,
  evaluate(context): StrategyCandidate[] {
    observe(context);
    if (!context.feed.healthy || !context.feed.derivativesHealthy || context.regime.liquidity === 'dislocated') return [];
    const candles = complete(context.candles.fiveMinute);
    const h1 = complete(context.candles.oneHour);
    if (candles.length < 24 || h1.length < 4) return [];
    const latest = candles.at(-1)!;
    const atr = averageTrueRange(candles, 14);
    if (!(atr > 0)) return [];

    const baseline = priorObservations(96);
    const funding = context.derivatives.fundingRate;
    const fundingZ = baseline.length >= 12
      ? zScore(baseline.map(item => item.fundingRate), funding)
      : safeDiv(funding, 0.0001, 0);
    const oiChange = context.derivatives.openInterestChangePct;
    const basis = context.derivatives.basisBps;
    const oneHourReturn = pct(h1.at(-2)!.close, context.prices.mark);
    const buySellFlow = safeDiv(context.orderFlow.aggressiveBuyUsd5m, context.orderFlow.aggressiveSellUsd5m, 1);

    let direction: BtcDirection | null = null;
    if (
      funding >= 0.00025 && fundingZ >= 1.6 && oiChange >= 0.25 && basis >= 2.5
      && latest.close < latest.open && buySellFlow < 0.95 && oneHourReturn < 0.45
    ) direction = 'short';
    if (
      funding <= -0.00025 && fundingZ <= -1.6 && oiChange >= 0.25 && basis <= -2.5
      && latest.close > latest.open && buySellFlow > 1.05 && oneHourReturn > -0.45
    ) direction = 'long';
    if (!direction) return [];

    const entry = currentPrice(context, direction);
    const swing = recentSwing(candles, direction, 8);
    const stop = direction === 'long' ? swing - atr * 0.18 : swing + atr * 0.18;
    const initialTarget = targetFromRisk(entry, stop, direction, 3.25);
    const extendedTarget = targetFromRisk(entry, stop, direction, 4.8);
    const alignedFlow = directionalFlow(context, direction);

    return [candidate(context, {
      strategyId: this.id,
      strategyVersion: this.version,
      strategyName: this.name,
      mode: this.mode,
      direction,
      setupType: direction === 'long' ? 'crowded_short_stall' : 'crowded_long_stall',
      entryMethod: 'market',
      preferredEntry: entry,
      entryZoneLow: direction === 'long' ? entry - atr * 0.1 : entry - atr * 0.05,
      entryZoneHigh: direction === 'long' ? entry + atr * 0.05 : entry + atr * 0.1,
      doNotChasePrice: direction === 'long' ? entry + atr * 0.35 : entry - atr * 0.35,
      expiresAt: context.timestamp + 25 * 60_000,
      structuralStop: stop,
      initialTarget,
      extendedTarget,
      maximumRealisticTarget: direction === 'long'
        ? entry + Math.max(atr * 10, entry * 0.035)
        : entry - Math.max(atr * 10, entry * 0.035),
      strategyLeverageCap: this.leverageCap,
      expectedHoldingMinutes: 240,
      exitModel: 'partial_runner',
      signalScore: 62 + Math.min(18, Math.abs(fundingZ) * 6) + Math.min(12, Math.abs(funding) * 20_000) + Math.max(0, alignedFlow - 1) * 10,
      regimeScore: context.regime.positioning === 'neutral' ? 76 : 94,
      executionScore: executionScore(context, 30),
      rationale: [
        `funding ${(funding * 100).toFixed(4)}% at z-score ${fundingZ.toFixed(2)}`,
        `open interest change ${oiChange.toFixed(2)}%`,
        `basis ${basis.toFixed(1)} bps`,
        'crowded side stopped producing one-hour progress',
      ],
      features: {
        funding,
        fundingZ,
        oiChange,
        basis,
        oneHourReturn,
        buySellFlow,
        alignedFlow,
        baselineCount: baseline.length,
        atr,
      },
    })];
  },
};
