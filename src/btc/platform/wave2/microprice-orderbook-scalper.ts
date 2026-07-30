import { safeDiv } from '../indicators';
import { BtcDirection, StrategyCandidate, StrategyDefinition } from '../types';
import { candidate, currentPrice, directionalFlow, executionScore, targetFromRisk } from './shared';

export const micropriceOrderBookScalper: StrategyDefinition = {
  id: 'btc-microprice-orderbook-scalper',
  version: '0.2.0-shadow',
  name: 'Microprice and Order-Book Imbalance Scalper',
  description: 'Researches very short-lived microprice pressure when top-of-book, five-basis-point depth and aggressive flow agree.',
  mode: 'shadow',
  leverageCap: 35,
  evaluate(context): StrategyCandidate[] {
    if (!context.feed.healthy || !context.feed.derivativesHealthy) return [];
    if (context.regime.liquidity === 'thin' || context.regime.liquidity === 'dislocated') return [];
    if ((context.feed.spreadBps ?? Infinity) > 2) return [];
    const bestBid = context.orderFlow.bids[0];
    const bestAsk = context.orderFlow.asks[0];
    if (!bestBid || !bestAsk || !(bestAsk.price > bestBid.price) || !(bestBid.size > 0 && bestAsk.size > 0)) return [];

    const mid = (bestBid.price + bestAsk.price) / 2;
    const spread = bestAsk.price - bestBid.price;
    const microprice = safeDiv(
      bestAsk.price * bestBid.size + bestBid.price * bestAsk.size,
      bestBid.size + bestAsk.size,
      mid,
    );
    const micropriceEdgeBps = safeDiv(microprice - mid, mid, 0) * 10_000;
    const topImbalance = context.orderFlow.topBookImbalance;
    const depthImbalance = context.orderFlow.depthImbalance5Bps;
    let direction: BtcDirection | null = null;
    if (micropriceEdgeBps >= 0.035 && topImbalance >= 0.22 && depthImbalance >= 0.10) direction = 'long';
    if (micropriceEdgeBps <= -0.035 && topImbalance <= -0.22 && depthImbalance <= -0.10) direction = 'short';
    if (!direction) return [];
    const flow = directionalFlow(context, direction, 'one');
    if (flow < 1.08 || context.orderFlow.bookFragility > 0.35) return [];

    const entry = currentPrice(context, direction);
    const stopDistance = Math.max(spread * 5, entry * 0.00035);
    const stop = direction === 'long' ? entry - stopDistance : entry + stopDistance;
    // Version 0.2.0 raises the native target above the modeled taker-fee,
    // spread and slippage floor. The earlier 3.4R target could be negative
    // after costs even when the price forecast was correct.
    const initialTarget = targetFromRisk(entry, stop, direction, 5);
    const extendedTarget = targetFromRisk(entry, stop, direction, 7.5);
    const maximumMove = Math.max(entry * 0.009, spread * 60);

    return [candidate(context, {
      strategyId: this.id,
      strategyVersion: this.version,
      strategyName: this.name,
      mode: this.mode,
      direction,
      setupType: direction === 'long' ? 'positive_microprice_pressure' : 'negative_microprice_pressure',
      entryMethod: 'market',
      preferredEntry: entry,
      entryZoneLow: direction === 'long' ? bestBid.price : bestBid.price - spread,
      entryZoneHigh: direction === 'long' ? bestAsk.price + spread : bestAsk.price,
      doNotChasePrice: direction === 'long' ? entry + spread * 4 : entry - spread * 4,
      expiresAt: context.timestamp + 30_000,
      structuralStop: stop,
      initialTarget,
      extendedTarget,
      maximumRealisticTarget: direction === 'long' ? entry + maximumMove : entry - maximumMove,
      strategyLeverageCap: this.leverageCap,
      expectedHoldingMinutes: 6,
      exitModel: 'fixed',
      signalScore: 70 + Math.min(12, Math.abs(micropriceEdgeBps) * 80)
        + Math.min(10, Math.abs(topImbalance) * 25) + Math.max(0, flow - 1) * 12,
      regimeScore: context.regime.liquidity === 'deep' ? 94 : 82,
      executionScore: executionScore(context, 45),
      rationale: [
        `microprice edge ${micropriceEdgeBps.toFixed(3)} bps`,
        `top-book imbalance ${topImbalance.toFixed(2)} and 5-bps depth imbalance ${depthImbalance.toFixed(2)}`,
        `one-minute aggressive-flow ratio ${flow.toFixed(2)}`,
        'native target is cost-covering under the shared paper execution model',
        'shadow-only because sub-minute signal decay and notification latency require direct measurement',
      ],
      features: {
        bestBid: bestBid.price,
        bestAsk: bestAsk.price,
        bestBidSize: bestBid.size,
        bestAskSize: bestAsk.size,
        mid,
        microprice,
        micropriceEdgeBps,
        topBookImbalance: topImbalance,
        depthImbalance5Bps: depthImbalance,
        flowRatio: flow,
        spread,
        bookFragility: context.orderFlow.bookFragility,
        nativeTargetRiskMultiple: 5,
      },
    })];
  },
};
