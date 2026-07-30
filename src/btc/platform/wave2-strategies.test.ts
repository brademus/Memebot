import assert from 'node:assert/strict';
import test from 'node:test';
import { solveResearchRiskPlan } from './research-risk';
import { WAVE2_STRATEGIES } from './wave2-strategies';
import { Candle, CrossAssetState, MarketContext, StrategyDefinition } from './types';

function candles(count: number, timeframeSec: number, start = 100_000, step = 2, range = 80, volume = 100): Candle[] {
  return Array.from({ length: count }, (_, index) => {
    const open = start + step * index;
    const close = open + step * 0.6;
    return {
      timeframeSec,
      startMs: index * timeframeSec * 1000,
      open,
      high: Math.max(open, close) + range * 0.5,
      low: Math.min(open, close) - range * 0.5,
      close,
      volume,
      tradeCount: 100,
      buyVolume: volume * 0.55,
      sellVolume: volume * 0.45,
      complete: true,
    };
  });
}

const healthyCrossAsset: CrossAssetState = {
  healthy: true,
  ethSpot: 3_500,
  ethAgeMs: 200,
  ethReturn5mPct: 0.8,
  ethReturn15mPct: 1.1,
  btcReturn5mPct: 0.2,
  btcReturn15mPct: 0.55,
  relativeReturn5mPct: 0.6,
  relativeReturn15mPct: 0.55,
};

function baseContext(overrides: Partial<MarketContext> = {}): MarketContext {
  const mark = overrides.prices?.mark ?? 100_000;
  return {
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
      oneMinute: candles(80, 60, mark * 0.997, 3, 70, 100),
      fiveMinute: candles(90, 300, mark * 0.985, 18, 110, 150),
      fifteenMinute: candles(100, 900, mark * 0.96, 40, 180, 250),
      oneHour: candles(60, 3600, mark * 0.88, 220, 600, 500),
      fourHour: candles(30, 14_400, mark * 0.75, 900, 1_800, 1_000),
      ...overrides.candles,
    },
    derivatives: {
      fundingRate: 0.00005,
      predictedFundingRate: 0.00005,
      nextFundingAt: Date.now() + 8 * 60 * 60_000,
      openInterest: 100_000,
      openInterestValue: 6_000_000_000,
      openInterestChangePct: 0.2,
      longLiquidationUsd5m: 0,
      shortLiquidationUsd5m: 0,
      basisBps: 1,
      ...overrides.derivatives,
    },
    orderFlow: {
      aggressiveBuyUsd1m: 1_400_000,
      aggressiveSellUsd1m: 900_000,
      aggressiveBuyUsd5m: 7_000_000,
      aggressiveSellUsd5m: 4_500_000,
      topBookImbalance: 0.15,
      depthImbalance5Bps: 0.12,
      bookFragility: 0.08,
      absorptionScore: 0.55,
      bids: [{ price: mark - 1, size: 40 }],
      asks: [{ price: mark + 1, size: 40 }],
      ...overrides.orderFlow,
    },
    crossAsset: overrides.crossAsset ?? healthyCrossAsset,
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
      spreadBps: 0.2,
      markIndexBps: 0,
      crossVenueBps: 0,
      recentSequenceGap: false,
      blockers: [],
      ...overrides.feed,
    },
  };
}

function strategy(id: string): StrategyDefinition {
  const found = WAVE2_STRATEGIES.find(item => item.id === id);
  if (!found) throw new Error(`missing ${id}`);
  return found;
}

function assertShadowCandidatePassesRisk(context: MarketContext, id: string, shouldApprove = true) {
  const candidates = strategy(id).evaluate(context);
  assert.equal(candidates.length, 1, `${id} did not emit`);
  assert.equal(candidates[0]!.mode, 'shadow');
  const plan = solveResearchRiskPlan(context, candidates[0]!);
  assert.equal(plan.approved, shouldApprove, `${id}: ${plan.rejectionReasons.join('; ')}`);
  if (shouldApprove) {
    assert.ok(plan.leverage <= strategy(id).leverageCap);
    assert.ok(plan.estimatedRewardUsd > 0);
    assert.ok(plan.estimatedNetRR >= 1.5);
    assert.ok(plan.estimatedTargetRoiPct >= 4);
    assert.ok(plan.estimatedRiskUsd <= 20 / 3 + 1e-6);
    assert.ok(plan.liquidationBufferPct > 0);
  } else {
    assert.ok(plan.rejectionReasons.some(reason => reason.includes('quality floor') || reason.includes('friction')));
  }
  return candidates[0]!;
}

test('Wave 2 registry contains five unique research-only strategies', () => {
  assert.equal(WAVE2_STRATEGIES.length, 5);
  assert.equal(new Set(WAVE2_STRATEGIES.map(item => item.id)).size, 5);
  for (const item of WAVE2_STRATEGIES) {
    assert.equal(item.mode, 'shadow');
    assert.ok(item.version.endsWith('-shadow'));
    assert.ok(item.leverageCap >= 1 && item.leverageCap <= 50);
  }
});

test('liquidation-cascade exhaustion emits after forced long deleveraging is reclaimed', () => {
  const context = baseContext({
    derivatives: {
      ...baseContext().derivatives,
      openInterestChangePct: -1.4,
      longLiquidationUsd5m: 8_000_000,
      shortLiquidationUsd5m: 500_000,
    },
    orderFlow: {
      ...baseContext().orderFlow,
      absorptionScore: 0.82,
      aggressiveBuyUsd5m: 8_000_000,
      aggressiveSellUsd5m: 5_000_000,
    },
    regime: { ...baseContext().regime, event: 'liquidation_cascade', volatility: 'extreme' },
  });
  const latest = context.candles.fiveMinute.at(-1)!;
  latest.open = 99_850;
  latest.high = 100_180;
  latest.low = 99_000;
  latest.close = 100_100;
  context.prices = { ...context.prices, last: 100_100, bid: 100_099, ask: 100_101, mark: 100_100 };
  const candidate = assertShadowCandidatePassesRisk(context, 'btc-liquidation-cascade-exhaustion');
  assert.equal(candidate.direction, 'long');
  assert.equal(candidate.setupType, 'long_liquidation_exhaustion');
});

test('CVD divergence compares cumulative delta at two confirmed price pivots before reclaim', () => {
  const context = baseContext({
    regime: { ...baseContext().regime, direction: 'range', directionalScore: 0 },
  });
  const sample = candles(45, 60, 100_000, 2, 50, 100);

  for (let index = 0; index <= 15; index++) {
    sample[index]!.buyVolume = 30;
    sample[index]!.sellVolume = 70;
  }
  for (let index = 16; index <= 35; index++) {
    sample[index]!.buyVolume = 80;
    sample[index]!.sellVolume = 20;
  }
  for (let index = 36; index < 45; index++) {
    sample[index]!.buyVolume = 65;
    sample[index]!.sellVolume = 35;
  }

  sample[15]!.low = 99_800;
  sample[15]!.high = 100_045;
  sample[15]!.open = 100_030;
  sample[15]!.close = 100_035;

  sample[35]!.low = 99_720;
  sample[35]!.high = 100_085;
  sample[35]!.open = 100_070;
  sample[35]!.close = 100_075;

  const latest = sample[44]!;
  latest.open = 100_080;
  latest.low = 100_060;
  latest.close = 100_160;
  latest.high = 100_190;

  context.candles.oneMinute = sample;
  context.prices = { ...context.prices, last: 100_160, bid: 100_159, ask: 100_161, mark: 100_160 };
  const candidate = assertShadowCandidatePassesRisk(context, 'btc-cvd-divergence');
  assert.equal(candidate.direction, 'long');
  assert.equal(candidate.setupType, 'pivot_bullish_cvd_divergence');
});

test('microprice signal remains observable but weak native economics are quarantined', () => {
  const context = baseContext({
    orderFlow: {
      ...baseContext().orderFlow,
      aggressiveBuyUsd1m: 2_000_000,
      aggressiveSellUsd1m: 800_000,
      topBookImbalance: 0.72,
      depthImbalance5Bps: 0.48,
      bookFragility: 0.06,
      bids: [{ price: 99_999, size: 120 }, { price: 99_998, size: 80 }],
      asks: [{ price: 100_001, size: 20 }, { price: 100_002, size: 25 }],
    },
  });
  const candidate = assertShadowCandidatePassesRisk(context, 'btc-microprice-orderbook-scalper', false);
  assert.equal(candidate.direction, 'long');
  assert.equal(candidate.setupType, 'positive_microprice_pressure');
});

test('ETH-led signal remains observable but weak native economics are quarantined', () => {
  const context = baseContext({
    crossAsset: {
      healthy: true,
      ethSpot: 3_500,
      ethAgeMs: 100,
      ethReturn5mPct: 0.9,
      ethReturn15mPct: 1.25,
      btcReturn5mPct: 0.18,
      btcReturn15mPct: 0.60,
      relativeReturn5mPct: 0.72,
      relativeReturn15mPct: 0.65,
    },
  });
  const latest = context.candles.oneMinute.at(-1)!;
  latest.open = 99_920;
  latest.close = 100_020;
  latest.high = 100_050;
  latest.low = 99_880;
  context.prices = { ...context.prices, last: 100_020, bid: 100_019, ask: 100_021, mark: 100_020 };
  const candidate = assertShadowCandidatePassesRisk(context, 'btc-eth-led-catch-up', false);
  assert.equal(candidate.direction, 'long');
  assert.equal(candidate.setupType, 'eth_up_btc_lag');
});

test('post-jump continuation emits after a high-volume jump forms a controlled shelf', () => {
  const context = baseContext();
  const series = candles(50, 300, 99_500, 4, 80, 100);
  const impulse = series[47]!;
  impulse.open = 99_900;
  impulse.low = 99_850;
  impulse.close = 101_000;
  impulse.high = 101_080;
  impulse.volume = 260;
  impulse.buyVolume = 220;
  impulse.sellVolume = 40;
  const shelfOne = series[48]!;
  shelfOne.open = 100_650;
  shelfOne.low = 100_550;
  shelfOne.close = 100_760;
  shelfOne.high = 100_840;
  const shelfTwo = series[49]!;
  shelfTwo.open = 100_720;
  shelfTwo.low = 100_600;
  shelfTwo.close = 100_940;
  shelfTwo.high = 101_010;
  context.candles.fiveMinute = series;
  context.prices = { ...context.prices, last: 100_940, bid: 100_939, ask: 100_941, mark: 100_940 };
  context.orderFlow.aggressiveBuyUsd5m = 9_000_000;
  context.orderFlow.aggressiveSellUsd5m = 4_000_000;
  const candidate = assertShadowCandidatePassesRisk(context, 'btc-post-jump-continuation');
  assert.equal(candidate.direction, 'long');
  assert.equal(candidate.setupType, 'bull_jump_shelf_continuation');
});
