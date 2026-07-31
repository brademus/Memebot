import { averageTrueRange } from '../indicators';
import { BtcDirection, StrategyCandidate, StrategyDefinition } from '../types';
import { candidate, complete, directionalFlow, executionScore, frictionFloorStop, minutesSinceFundingSettlement, recentSwing, targetFromRisk } from './shared';

/**
 * Funding-settlement relief drift.
 *
 * Evidence: intraday microstructure work ties spread/flow patterns to the 8h
 * funding settlements, and funding-extreme mean reversion is one of the most
 * consistently documented perp effects: a deeply negative rate means shorts
 * just paid dearly to stay in — once the payment clears, the pressured side
 * covers and the market drifts against the crowd. This trades the first
 * half-hour after settlement, only when the just-paid rate was extreme and
 * price is already moving against the crowded side.
 */
export const fundingSettlementRelief: StrategyDefinition = {
  id: 'btc-funding-settlement-relief',
  version: '0.1.0-shadow',
  name: 'Funding-Settlement Relief',
  description: 'Researches post-settlement drift against the side that just paid an extreme funding rate, entered in the first 30 minutes after the 8h settlement with confirming flow.',
  mode: 'shadow',
  leverageCap: 10,
  evaluate(context): StrategyCandidate[] {
    if (!context.feed.healthy || context.regime.liquidity === 'dislocated') return [];
    const sinceSettlement = minutesSinceFundingSettlement(context);
    if (sinceSettlement === null || sinceSettlement > 30) return [];

    const rate = context.derivatives.fundingRate;
    const EXTREME = 0.0003;   // 0.03% per 8h — ~3x the 0.01% equilibrium
    if (Math.abs(rate) < EXTREME) return [];
    // Positive extreme = longs crowded and paying -> relief is DOWN.
    const direction: BtcDirection = rate > 0 ? 'short' : 'long';

    const fiveMinute = complete(context.candles.fiveMinute);
    if (fiveMinute.length < 40) return [];
    const atr = averageTrueRange(fiveMinute, 20);
    if (!(atr > 0)) return [];
    const last = fiveMinute.at(-1)!;
    const moving = direction === 'short' ? last.close < last.open : last.close > last.open;
    if (!moving) return [];
    const flow = directionalFlow(context, direction);
    if (flow < 1.08) return [];

    const entry = context.prices.last;
    const rawStop = recentSwing(fiveMinute, direction, 6);
    const stop = frictionFloorStop(entry, rawStop, direction, atr);
    const initialTarget = targetFromRisk(entry, stop, direction, 2.4);

    return [candidate(context, {
      strategyId: this.id,
      strategyVersion: this.version,
      strategyName: this.name,
      mode: this.mode,
      direction,
      setupType: direction === 'short' ? 'post_settlement_long_relief' : 'post_settlement_short_squeeze',
      entryMethod: 'market',
      preferredEntry: entry,
      entryZoneLow: entry - atr * 0.25,
      entryZoneHigh: entry + atr * 0.25,
      doNotChasePrice: direction === 'long' ? entry + atr * 0.7 : entry - atr * 0.7,
      expiresAt: context.timestamp + 20 * 60_000,
      structuralStop: stop,
      initialTarget,
      extendedTarget: targetFromRisk(entry, stop, direction, 3.6),
      maximumRealisticTarget: targetFromRisk(entry, stop, direction, 5),
      strategyLeverageCap: this.leverageCap,
      expectedHoldingMinutes: 90,
      exitModel: 'partial_runner',
      signalScore: 60 + Math.min(18, (Math.abs(rate) / EXTREME - 1) * 12) + Math.min(10, (flow - 1.08) * 25),
      regimeScore: context.regime.positioning === (rate > 0 ? 'long_crowded' : 'short_crowded') ? 88 : 68,
      executionScore: executionScore(context),
      rationale: [
        `${(rate * 100).toFixed(3)}%/8h funding just settled — ${rate > 0 ? 'longs' : 'shorts'} paid an extreme rate`,
        `${sinceSettlement.toFixed(0)} minutes after settlement, price already drifting against the crowd`,
        `aggressor flow ${flow.toFixed(2)} confirms the relief direction`,
      ],
      features: {
        fundingRate: rate, minutesSinceSettlement: sinceSettlement, flowRatio: flow, atr,
        positioning: context.regime.positioning,
      },
    })];
  },
};
