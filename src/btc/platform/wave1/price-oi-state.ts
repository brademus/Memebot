import { BtcDirection, StrategyCandidate, StrategyDefinition } from '../types';
import { averageTrueRange, pct, safeDiv } from '../indicators';
import { candidate, complete, currentPrice, directionalFlow, executionScore, observe, recentSwing, targetFromRisk } from './shared';

export const priceOpenInterestState: StrategyDefinition = {
  id: 'btc-price-oi-state',
  version: '1.0.0',
  name: 'Price–Open-Interest State Machine',
  description: 'Classifies position building, covering and deleveraging from joint price, open-interest and taker-flow behavior.',
  mode: 'actionable',
  leverageCap: 25,
  evaluate(context): StrategyCandidate[] {
    observe(context);
    if (!context.feed.healthy || !context.feed.derivativesHealthy || context.regime.liquidity === 'dislocated') return [];
    const h1 = complete(context.candles.oneHour);
    const m5 = complete(context.candles.fiveMinute);
    if (h1.length < 8 || m5.length < 24) return [];
    const latest = m5.at(-1)!;
    const atr = averageTrueRange(m5, 14);
    if (!(atr > 0)) return [];

    const twoHourReturn = pct(h1.at(-3)!.close, context.prices.mark);
    const oiChange = context.derivatives.openInterestChangePct;
    const buySellFlow = safeDiv(context.orderFlow.aggressiveBuyUsd5m, context.orderFlow.aggressiveSellUsd5m, 1);
    let direction: BtcDirection | null = null;
    let setupType = '';
    let stateQuality = 0;

    if (twoHourReturn >= 0.35 && oiChange >= 0.3 && latest.close > latest.open && buySellFlow >= 1.08) {
      direction = 'long';
      setupType = 'long_position_building';
      stateQuality = Math.min(20, twoHourReturn * 8) + Math.min(16, oiChange * 8);
    } else if (twoHourReturn <= -0.35 && oiChange >= 0.3 && latest.close < latest.open && buySellFlow <= 0.92) {
      direction = 'short';
      setupType = 'short_position_building';
      stateQuality = Math.min(20, Math.abs(twoHourReturn) * 8) + Math.min(16, oiChange * 8);
    } else if (twoHourReturn >= 0.5 && oiChange <= -0.6 && latest.close < latest.open && buySellFlow < 0.96) {
      direction = 'short';
      setupType = 'short_covering_exhaustion';
      stateQuality = Math.min(18, twoHourReturn * 7) + Math.min(18, Math.abs(oiChange) * 7);
    } else if (twoHourReturn <= -0.5 && oiChange <= -0.6 && latest.close > latest.open && buySellFlow > 1.04) {
      direction = 'long';
      setupType = 'long_liquidation_exhaustion';
      stateQuality = Math.min(18, Math.abs(twoHourReturn) * 7) + Math.min(18, Math.abs(oiChange) * 7);
    }
    if (!direction) return [];

    const entry = currentPrice(context, direction);
    const swing = recentSwing(m5, direction, 10);
    const stop = direction === 'long' ? swing - atr * 0.18 : swing + atr * 0.18;
    const initialTarget = targetFromRisk(entry, stop, direction, 3.3);
    const extendedTarget = targetFromRisk(entry, stop, direction, 5.2);
    const alignedFlow = directionalFlow(context, direction);

    return [candidate(context, {
      strategyId: this.id,
      strategyVersion: this.version,
      strategyName: this.name,
      mode: this.mode,
      direction,
      setupType,
      entryMethod: setupType.includes('building') ? 'retest' : 'market',
      preferredEntry: entry,
      entryZoneLow: direction === 'long' ? entry - atr * 0.15 : entry - atr * 0.06,
      entryZoneHigh: direction === 'long' ? entry + atr * 0.06 : entry + atr * 0.15,
      doNotChasePrice: direction === 'long' ? entry + atr * 0.45 : entry - atr * 0.45,
      expiresAt: context.timestamp + 35 * 60_000,
      structuralStop: stop,
      initialTarget,
      extendedTarget,
      maximumRealisticTarget: direction === 'long'
        ? entry + Math.max(atr * 10, entry * 0.03)
        : entry - Math.max(atr * 10, entry * 0.03),
      strategyLeverageCap: this.leverageCap,
      expectedHoldingMinutes: 300,
      exitModel: 'partial_runner',
      signalScore: 58 + stateQuality + Math.max(0, alignedFlow - 1) * 12,
      regimeScore: setupType.includes('building') ? 88 : 80,
      executionScore: executionScore(context, 28),
      rationale: [
        setupType.replaceAll('_', ' '),
        `two-hour price return ${twoHourReturn.toFixed(2)}%`,
        `open interest change ${oiChange.toFixed(2)}%`,
        `five-minute buy/sell flow ratio ${buySellFlow.toFixed(2)}`,
      ],
      features: {
        setupType,
        twoHourReturn,
        oiChange,
        buySellFlow,
        alignedFlow,
        stateQuality,
        atr,
      },
    })];
  },
};
