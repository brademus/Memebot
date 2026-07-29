import { averageTrueRange, safeDiv } from '../indicators';
import { BtcDirection, StrategyCandidate, StrategyDefinition } from '../types';
import { candidate, complete, currentPrice, directionalFlow, executionScore, targetFromRisk } from './shared';

export const liquidationCascadeExhaustion: StrategyDefinition = {
  id: 'btc-liquidation-cascade-exhaustion',
  version: '0.1.0-shadow',
  name: 'Liquidation-Cascade Exhaustion',
  description: 'Researches reversal after one-sided forced liquidation, open-interest contraction, absorption and candle reclaim.',
  mode: 'shadow',
  leverageCap: 15,
  evaluate(context): StrategyCandidate[] {
    if (!context.feed.healthy || !context.feed.derivativesHealthy || context.regime.liquidity === 'dislocated') return [];
    const candles = complete(context.candles.fiveMinute);
    if (candles.length < 20) return [];
    const latest = candles.at(-1)!;
    const atr = averageTrueRange(candles, 14);
    if (!(atr > 0)) return [];

    const longLiquidations = context.derivatives.longLiquidationUsd5m;
    const shortLiquidations = context.derivatives.shortLiquidationUsd5m;
    const totalLiquidations = longLiquidations + shortLiquidations;
    const liquidationShareOfOi = safeDiv(totalLiquidations, Math.max(context.derivatives.openInterestValue, 1), 0);
    const longDominance = safeDiv(longLiquidations, Math.max(shortLiquidations, 1), 0);
    const shortDominance = safeDiv(shortLiquidations, Math.max(longLiquidations, 1), 0);
    const range = Math.max(latest.high - latest.low, 1e-9);
    const closeLocation = safeDiv(latest.close - latest.low, range, 0.5);
    const lowerWick = safeDiv(Math.min(latest.open, latest.close) - latest.low, range, 0);
    const upperWick = safeDiv(latest.high - Math.max(latest.open, latest.close), range, 0);
    const oiContracting = context.derivatives.openInterestChangePct <= -0.65;

    let direction: BtcDirection | null = null;
    if (
      longLiquidations >= 2_000_000
      && longDominance >= 2.5
      && oiContracting
      && closeLocation >= 0.58
      && lowerWick >= 0.25
      && (context.orderFlow.absorptionScore >= 0.42 || directionalFlow(context, 'long') >= 1.08)
    ) direction = 'long';
    if (
      shortLiquidations >= 2_000_000
      && shortDominance >= 2.5
      && oiContracting
      && closeLocation <= 0.42
      && upperWick >= 0.25
      && (context.orderFlow.absorptionScore >= 0.42 || directionalFlow(context, 'short') >= 1.08)
    ) direction = 'short';
    if (!direction) return [];

    const entry = currentPrice(context, direction);
    const stop = direction === 'long' ? latest.low - atr * 0.12 : latest.high + atr * 0.12;
    const initialTarget = targetFromRisk(entry, stop, direction, 3.6);
    const extendedTarget = targetFromRisk(entry, stop, direction, 5.5);
    const liquidationPressure = direction === 'long' ? longLiquidations : shortLiquidations;
    const dominance = direction === 'long' ? longDominance : shortDominance;
    const flow = directionalFlow(context, direction);

    return [candidate(context, {
      strategyId: this.id,
      strategyVersion: this.version,
      strategyName: this.name,
      mode: this.mode,
      direction,
      setupType: direction === 'long' ? 'long_liquidation_exhaustion' : 'short_liquidation_exhaustion',
      entryMethod: 'market',
      preferredEntry: entry,
      entryZoneLow: direction === 'long' ? entry - atr * 0.08 : entry - atr * 0.04,
      entryZoneHigh: direction === 'long' ? entry + atr * 0.04 : entry + atr * 0.08,
      doNotChasePrice: direction === 'long' ? entry + atr * 0.45 : entry - atr * 0.45,
      expiresAt: context.timestamp + 10 * 60_000,
      structuralStop: stop,
      initialTarget,
      extendedTarget,
      maximumRealisticTarget: direction === 'long'
        ? entry + Math.max(atr * 10, entry * 0.07)
        : entry - Math.max(atr * 10, entry * 0.07),
      strategyLeverageCap: this.leverageCap,
      expectedHoldingMinutes: 90,
      exitModel: 'partial_runner',
      signalScore: 68 + Math.min(14, dominance * 2) + Math.min(10, liquidationPressure / 1_000_000) + context.orderFlow.absorptionScore * 10,
      regimeScore: context.regime.event === 'liquidation_cascade' ? 94 : 78,
      executionScore: executionScore(context, 34),
      rationale: [
        `$${Math.round(liquidationPressure).toLocaleString()} dominant five-minute forced liquidation`,
        `dominant-side liquidation ratio ${dominance.toFixed(2)}x`,
        `open interest contracted ${context.derivatives.openInterestChangePct.toFixed(2)}%`,
        `reversal flow ratio ${flow.toFixed(2)} with absorption ${context.orderFlow.absorptionScore.toFixed(2)}`,
      ],
      features: {
        longLiquidations,
        shortLiquidations,
        totalLiquidations,
        liquidationShareOfOi,
        dominance,
        openInterestChangePct: context.derivatives.openInterestChangePct,
        closeLocation,
        lowerWick,
        upperWick,
        absorptionScore: context.orderFlow.absorptionScore,
        flowRatio: flow,
        atr,
      },
    })];
  },
};
