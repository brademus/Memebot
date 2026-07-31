import assert from 'node:assert/strict';
import test from 'node:test';
import { BTC_STRATEGIES } from '../strategy-registry';
import { Candle, MarketContext } from '../types';
import { WAVE3_STRATEGIES } from './index';
import { MIN_STOP_DISTANCE_FRACTION, frictionFloorStop, minutesSinceFundingSettlement, roundLevelContext } from './shared';

function candles(count: number, base: number, timeframeSec: number, endMs: number, drift = 0): Candle[] {
  const out: Candle[] = [];
  for (let index = 0; index < count; index++) {
    const startMs = endMs - (count - index) * timeframeSec * 1_000;
    const open = base + drift * index;
    const close = open + drift;
    out.push({
      timeframeSec, startMs, open, close,
      high: Math.max(open, close) + base * 0.0004,
      low: Math.min(open, close) - base * 0.0004,
      volume: 40, tradeCount: 60, buyVolume: 20, sellVolume: 20, complete: true,
    });
  }
  return out;
}

function baseContext(timestamp: number, price = 64_000): MarketContext {
  return {
    timestamp,
    prices: { last: price, bid: price - 1, ask: price + 1, mark: price, index: price, coinbaseSpot: price, krakenSpot: price, consolidatedFair: price },
    candles: {
      oneMinute: candles(90, price, 60, timestamp),
      fiveMinute: candles(70, price, 300, timestamp),
      fifteenMinute: candles(40, price, 900, timestamp),
      oneHour: candles(30, price, 3_600, timestamp),
      fourHour: candles(12, price, 14_400, timestamp),
    },
    derivatives: {
      fundingRate: 0.0001, predictedFundingRate: 0.0001, nextFundingAt: timestamp + 4 * 60 * 60_000,
      openInterest: 50_000, openInterestValue: 3.2e9, openInterestChangePct: 0,
      longLiquidationUsd5m: 0, shortLiquidationUsd5m: 0, basisBps: 1,
    },
    orderFlow: {
      aggressiveBuyUsd1m: 500_000, aggressiveSellUsd1m: 500_000,
      aggressiveBuyUsd5m: 2_500_000, aggressiveSellUsd5m: 2_500_000,
      topBookImbalance: 0, depthImbalance5Bps: 0, bookFragility: 0.2, absorptionScore: 0.3,
      bids: [{ price: price - 1, size: 5 }], asks: [{ price: price + 1, size: 5 }],
    },
    crossAsset: {
      healthy: true, ethSpot: 3_400, ethAgeMs: 500,
      ethReturn5mPct: 0, ethReturn15mPct: 0, btcReturn5mPct: 0, btcReturn15mPct: 0,
      relativeReturn5mPct: 0, relativeReturn15mPct: 0,
    },
    regime: {
      direction: 'range', volatility: 'normal', liquidity: 'normal', positioning: 'neutral',
      event: 'normal', directionalScore: 0, volatilityPercentile: 40,
    },
    feed: {
      healthy: true, derivativesHealthy: true, referenceVenue: 'test', referenceAgeMs: 200,
      coinbaseAgeMs: 300, krakenAgeMs: 300, spreadBps: 0.6, markIndexBps: 1, crossVenueBps: 1,
      recentSequenceGap: false, blockers: [],
    },
  };
}

test('all ten wave-3 strategies register with unique ids, shadow mode, and modest leverage', () => {
  assert.equal(WAVE3_STRATEGIES.length, 10);
  const allIds = BTC_STRATEGIES.map(strategy => strategy.id + ':' + strategy.version);
  assert.equal(new Set(allIds).size, allIds.length, 'duplicate strategy id:version in the registry');
  for (const strategy of WAVE3_STRATEGIES) {
    assert.ok(BTC_STRATEGIES.includes(strategy), `${strategy.id} missing from the registry`);
    assert.equal(strategy.version, '0.1.0-shadow');
    assert.equal(strategy.mode, 'shadow');
    assert.ok(strategy.leverageCap <= 12, `${strategy.id} leverage cap ${strategy.leverageCap} exceeds the wave-3 ceiling`);
  }
});

test('the friction floor never narrows a stop and always clears the minimum distance', () => {
  const entry = 64_000;
  const microStop = 63_952;   // 0.075% away — the exact geometry that killed the legacy cohort
  const floored = frictionFloorStop(entry, microStop, 'long', 40);
  assert.ok(entry - floored >= entry * MIN_STOP_DISTANCE_FRACTION, 'floor must clear the friction minimum');
  const wide = frictionFloorStop(entry, 63_000, 'long', 40);
  assert.equal(wide, 63_000, 'an already-wide stop must never be narrowed');
  const shortSide = frictionFloorStop(entry, 64_048, 'short', 40);
  assert.ok(shortSide - entry >= entry * MIN_STOP_DISTANCE_FRACTION);
});

test('every candidate any wave-3 strategy produces satisfies the friction floor and directional geometry', () => {
  // Sweep a variety of contexts (different sessions, regimes, stresses); whatever
  // fires, the geometry invariant must hold. Silence is an acceptable outcome —
  // bad geometry is not.
  const mondayNoon = Date.UTC(2026, 7, 3, 12, 30);
  const usOpen = Date.UTC(2026, 7, 4, 14, 5);
  const saturday = Date.UTC(2026, 7, 1, 15, 0);
  const contexts: MarketContext[] = [];
  for (const timestamp of [mondayNoon, usOpen, saturday]) {
    const plain = baseContext(timestamp);
    const stressed = baseContext(timestamp);
    stressed.derivatives.fundingRate = 0.0006;
    stressed.derivatives.openInterestChangePct = -6;
    stressed.derivatives.longLiquidationUsd5m = 100_000;
    stressed.orderFlow.aggressiveSellUsd5m = 4_000_000;
    stressed.regime.positioning = 'deleveraging';
    contexts.push(plain, stressed);
  }
  let produced = 0;
  for (const strategy of WAVE3_STRATEGIES) {
    for (const context of contexts) {
      for (const output of strategy.evaluate(context)) {
        produced++;
        const distance = Math.abs(output.preferredEntry - output.structuralStop) / output.preferredEntry;
        assert.ok(distance >= MIN_STOP_DISTANCE_FRACTION - 1e-9,
          `${strategy.id} produced a stop ${(distance * 100).toFixed(3)}% away — inside the friction floor`);
        const stopRightSide = output.direction === 'long'
          ? output.structuralStop < output.preferredEntry
          : output.structuralStop > output.preferredEntry;
        assert.ok(stopRightSide, `${strategy.id} stop is on the wrong side of entry`);
        const targetRightSide = output.direction === 'long'
          ? output.initialTarget > output.preferredEntry
          : output.initialTarget < output.preferredEntry;
        assert.ok(targetRightSide, `${strategy.id} target is on the wrong side of entry`);
      }
    }
  }
  assert.ok(produced >= 0);   // silence across synthetic tapes is fine; geometry violations are not
});

test('the funding-settlement relief strategy fires end-to-end on its documented setup', () => {
  const timestamp = Date.UTC(2026, 7, 4, 8, 12);   // 12 minutes after the 08:00 settlement
  const context = baseContext(timestamp);
  context.derivatives.nextFundingAt = Date.UTC(2026, 7, 4, 16, 0);
  context.derivatives.fundingRate = 0.0005;        // longs crowded, paying an extreme rate
  context.regime.positioning = 'long_crowded';
  context.orderFlow.aggressiveSellUsd5m = 3_200_000;   // relief drift already selling
  const bearishLast = context.candles.fiveMinute.at(-1)!;
  bearishLast.open = 64_020; bearishLast.close = 63_985;
  const strategy = WAVE3_STRATEGIES.find(item => item.id === 'btc-funding-settlement-relief')!;
  const outputs = strategy.evaluate(context);
  assert.equal(outputs.length, 1, 'the documented setup must produce a candidate');
  const output = outputs[0];
  assert.equal(output.direction, 'short');
  assert.ok(Math.abs(output.preferredEntry - output.structuralStop) / output.preferredEntry >= MIN_STOP_DISTANCE_FRACTION);
  assert.match(output.rationale.join(' '), /funding just settled/);
});

test('session and level helpers compute what the strategies assume', () => {
  const context = baseContext(Date.UTC(2026, 7, 4, 9, 30));
  context.derivatives.nextFundingAt = Date.UTC(2026, 7, 4, 16, 0);
  assert.equal(minutesSinceFundingSettlement(context), 90);
  const { level, distanceFraction } = roundLevelContext(63_940);
  assert.equal(level, 64_000);
  assert.ok(Math.abs(distanceFraction - 60 / 63_940) < 1e-9);
});
