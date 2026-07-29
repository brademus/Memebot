import assert from 'node:assert/strict';
import test from 'node:test';
import { WAVE1_STRATEGIES, resetWave1StrategyStateForTests } from './wave1-strategies';
import { solveRiskPlan } from './risk';
import { Candle, MarketContext, StrategyDefinition } from './types';

function candles(
  count: number,
  timeframeSec: number,
  start: number,
  step: number,
  options: { range?: number; volume?: number; lastDirection?: 'up' | 'down'; breakout?: 'up' | 'down' } = {},
): Candle[] {
  const result: Candle[] = [];
  const range = options.range ?? Math.max(10, start * 0.0008);
  const volume = options.volume ?? 100;
  for (let index = 0; index < count; index++) {
    const open = start + step * index;
    let close = open + step * 0.7;
    if (index === count - 1 && options.lastDirection === 'down') close = open - Math.abs(step || range * 0.25);
    if (index === count - 1 && options.lastDirection === 'up') close = open + Math.abs(step || range * 0.25);
    result.push({
      timeframeSec,
      startMs: index * timeframeSec * 1000,
      open,
      high: Math.max(open, close) + range * 0.5,
      low: Math.min(open, close) - range * 0.5,
      close,
      volume: index === count - 1 && options.breakout ? volume * 2 : volume,
      tradeCount: 50,
      buyVolume: close >= open ? volume * 0.6 : volume * 0.4,
      sellVolume: close >= open ? volume * 0.4 : volume * 0.6,
      complete: true,
    });
  }
  if (options.breakout && result.length > 2) {
    const prior = result.slice(0, -1);
    const last = result.at(-1)!;
    if (options.breakout === 'up') {
      const high = Math.max(...prior.map(item => item.high));
      last.open = high - range * 0.2;
      last.close = high + range * 0.8;
      last.high = last.close + range * 0.2;
      last.low = last.open - range * 0.2;
    } else {
      const low = Math.min(...prior.map(item => item.low));
      last.open = low + range * 0.2;
      last.close = low - range * 0.8;
      last.high = last.open + range * 0.2;
      last.low = last.close - range * 0.2;
    }
  }
  return result;
}

function baseContext(overrides: Partial<MarketContext> = {}): MarketContext {
  const mark = overrides.prices?.mark ?? 100_000;
  const context: MarketContext = {
    timestamp: Date.now(),
    prices: {
      last: mark,
      bid: mark - 1,
      ask: mark + 1,
      mark,
      index: mark,
      coinbaseSpot: mark,
      krakenSpot: mark,
      consolidatedFair: mark,
      ...overrides.prices,
    },
    candles: {
      oneMinute: candles(80, 60, mark * 0.995, 2),
      fiveMinute: candles(90, 300, mark * 0.985, 18),
      fifteenMinute: candles(100, 900, mark * 0.96, 42),
      oneHour: candles(40, 3600, mark * 0.90, 250),
      fourHour: candles(12, 14400, mark * 0.82, 1500),
      ...overrides.candles,
    },
    derivatives: {
      fundingRate: 0.00005,
      predictedFundingRate: 0.00005,
      nextFundingAt: Date.now() + 8 * 60 * 60_000,
      openInterest: 100_000,
      openInterestValue: 6_000_000_000,
      openInterestChangePct: 0.4,
      longLiquidationUsd5m: 0,
      shortLiquidationUsd5m: 0,
      basisBps: 1,
      ...overrides.derivatives,
    },
    orderFlow: {
      aggressiveBuyUsd1m: 1_200_000,
      aggressiveSellUsd1m: 900_000,
      aggressiveBuyUsd5m: 6_000_000,
      aggressiveSellUsd5m: 4_500_000,
      topBookImbalance: 0.15,
      depthImbalance5Bps: 0.12,
      bookFragility: 0.08,
      absorptionScore: 0.5,
      bids: [{ price: mark - 1, size: 40 }],
      asks: [{ price: mark + 1, size: 40 }],
      ...overrides.orderFlow,
    },
    regime: {
      direction: 'bull',
      volatility: 'normal',
      liquidity: 'deep',
      positioning: 'neutral',
      event: 'normal',
      directionalScore: 45,
      volatilityPercentile: 55,
      ...overrides.regime,
    },
    feed: {
      healthy: true,
      derivativesHealthy: true,
      referenceVenue: 'TEST-BTCUSDT',
      referenceAgeMs: 10,
      coinbaseAgeMs: 10,
      krakenAgeMs: 10,
      spreadBps: 0.25,
      markIndexBps: 0,
      crossVenueBps: 0,
      recentSequenceGap: false,
      blockers: [],
      ...overrides.feed,
    },
  };
  return context;
}

function strategy(id: string): StrategyDefinition {
  const found = WAVE1_STRATEGIES.find(item => item.id === id);
  if (!found) throw new Error(`missing ${id}`);
  return found;
}

function seedObservations(count = 16): void {
  for (let index = 0; index < count; index++) {
    const context = baseContext({
      timestamp: Date.now() + index * 5 * 60_000,
      derivatives: {
        ...baseContext().derivatives,
        fundingRate: 0.00004 + index * 0.000001,
        basisBps: 1 + index * 0.03,
        openInterestChangePct: 0.1,
      },
      prices: {
        ...baseContext().prices,
        mark: 100_000 + index,
        consolidatedFair: 100_000 + index,
      },
    });
    WAVE1_STRATEGIES[0].evaluate(context);
  }
}

test('Wave 1 registry contains five unique actionable 24/7 strategies', () => {
  assert.equal(WAVE1_STRATEGIES.length, 5);
  assert.equal(new Set(WAVE1_STRATEGIES.map(item => item.id)).size, 5);
  for (const item of WAVE1_STRATEGIES) {
    assert.equal(item.mode, 'actionable');
    assert.ok(item.leverageCap >= 1 && item.leverageCap <= 50);
    assert.ok(item.version.length > 0);
  }
});

test('adaptive trend rider emits a long pullback candidate in aligned rolling trend', () => {
  resetWave1StrategyStateForTests();
  const context = baseContext();
  const prior = context.candles.fifteenMinute.at(-2)!;
  prior.open = 99_760;
  prior.close = 99_700;
  prior.high = 99_850;
  prior.low = 99_600;
  const latest = context.candles.fifteenMinute.at(-1)!;
  latest.open = 99_650;
  latest.close = 99_900;
  latest.high = 100_100;
  latest.low = 99_500;
  context.prices = { ...context.prices, last: 99_900, bid: 99_899, ask: 99_901, mark: 99_900, index: 99_900, consolidatedFair: 99_900 };
  const candidates = strategy('btc-adaptive-trend-rider').evaluate(context);
  assert.equal(candidates.length, 1);
  const plan = solveRiskPlan(context, candidates[0]!);
  assert.equal(plan.approved, true, plan.rejectionReasons.join('; '));
  assert.equal(candidates[0].direction, 'long');
  assert.equal(candidates[0].setupType, 'adaptive_trend_pullback');
});

test('Donchian strategy emits on accepted rolling-channel breakout without compression requirement', () => {
  resetWave1StrategyStateForTests();
  const context = baseContext({
    candles: {
      ...baseContext().candles,
      fifteenMinute: candles(100, 900, 99_000, 5, { range: 80, volume: 100, breakout: 'up' }),
    },
  });
  context.orderFlow.aggressiveBuyUsd5m = 8_000_000;
  context.orderFlow.aggressiveSellUsd5m = 4_000_000;
  const candidates = strategy('btc-donchian-trend-breakout').evaluate(context);
  assert.equal(candidates.length, 1);
  const plan = solveRiskPlan(context, candidates[0]!);
  assert.equal(plan.approved, true, plan.rejectionReasons.join('; '));
  assert.equal(candidates[0].direction, 'long');
});

test('funding crowding reversal requires rolling extreme plus price stall', () => {
  resetWave1StrategyStateForTests();
  seedObservations();
  const context = baseContext({
    timestamp: Date.now() + 17 * 5 * 60_000,
    derivatives: {
      ...baseContext().derivatives,
      fundingRate: 0.0007,
      openInterestChangePct: 0.8,
      basisBps: 8,
    },
    orderFlow: {
      ...baseContext().orderFlow,
      aggressiveBuyUsd5m: 3_500_000,
      aggressiveSellUsd5m: 6_000_000,
    },
  });
  const latest = context.candles.fiveMinute.at(-1)!;
  latest.open = 100_100;
  latest.close = 99_900;
  latest.high = 100_180;
  latest.low = 99_820;
  const candidates = strategy('btc-funding-crowding-reversal').evaluate(context);
  assert.equal(candidates.length, 1);
  const plan = solveRiskPlan(context, candidates[0]!);
  assert.equal(plan.approved, true, plan.rejectionReasons.join('; '));
  assert.equal(candidates[0].direction, 'short');
});

test('perpetual premium convergence emits after statistically rich perp begins reverting', () => {
  resetWave1StrategyStateForTests();
  seedObservations();
  const context = baseContext({
    timestamp: Date.now() + 17 * 5 * 60_000,
    prices: {
      ...baseContext().prices,
      mark: 101_000,
      last: 101_000,
      bid: 100_999,
      ask: 101_001,
      index: 100_000,
      consolidatedFair: 100_000,
    },
    derivatives: {
      ...baseContext().derivatives,
      fundingRate: 0.0003,
      basisBps: 100,
    },
    orderFlow: {
      ...baseContext().orderFlow,
      aggressiveBuyUsd5m: 4_000_000,
      aggressiveSellUsd5m: 5_500_000,
    },
  });
  const latest = context.candles.fiveMinute.at(-1)!;
  latest.open = 101_080;
  latest.close = 100_950;
  const candidates = strategy('btc-perp-premium-convergence').evaluate(context);
  assert.equal(candidates.length, 1);
  const plan = solveRiskPlan(context, candidates[0]!);
  assert.equal(plan.approved, true, plan.rejectionReasons.join('; '));
  assert.equal(candidates[0].direction, 'short');
  assert.equal(candidates[0].initialTarget, 100_000);
});

test('price-OI state machine identifies long position building', () => {
  resetWave1StrategyStateForTests();
  const context = baseContext({
    derivatives: {
      ...baseContext().derivatives,
      openInterestChangePct: 1.1,
    },
  });
  context.orderFlow.aggressiveBuyUsd5m = 7_500_000;
  context.orderFlow.aggressiveSellUsd5m = 4_000_000;
  const latest = context.candles.fiveMinute.at(-1)!;
  latest.open = 99_850;
  latest.close = 100_050;
  const candidates = strategy('btc-price-oi-state').evaluate(context);
  assert.equal(candidates.length, 1);
  const plan = solveRiskPlan(context, candidates[0]!);
  assert.equal(plan.approved, true, plan.rejectionReasons.join('; '));
  assert.equal(candidates[0].direction, 'long');
  assert.equal(candidates[0].setupType, 'long_position_building');
});
