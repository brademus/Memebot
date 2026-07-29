import assert from 'node:assert/strict';
import test from 'node:test';
import { solveRiskPlan } from './risk';
import { BTC_STRATEGIES } from './strategies';
import { MarketContext, StrategyCandidate } from './types';

const context: MarketContext = {
  timestamp: Date.now(),
  prices: {
    last: 100_000,
    bid: 99_999,
    ask: 100_001,
    mark: 100_000,
    index: 100_000,
    coinbaseSpot: 100_000,
    krakenSpot: 100_002,
    consolidatedFair: 100_001,
  },
  candles: { oneMinute: [], fiveMinute: [], fifteenMinute: [], oneHour: [], fourHour: [] },
  derivatives: {
    fundingRate: 0.00005,
    predictedFundingRate: 0.00005,
    nextFundingAt: Date.now() + 8 * 60 * 60_000,
    openInterest: 1_000,
    openInterestValue: 100_000_000,
    openInterestChangePct: 0.2,
    longLiquidationUsd5m: 0,
    shortLiquidationUsd5m: 0,
    basisBps: 0,
  },
  orderFlow: {
    aggressiveBuyUsd1m: 1_000_000,
    aggressiveSellUsd1m: 900_000,
    aggressiveBuyUsd5m: 5_000_000,
    aggressiveSellUsd5m: 4_500_000,
    topBookImbalance: 0.1,
    depthImbalance5Bps: 0.1,
    bookFragility: 0.05,
    absorptionScore: 0.5,
    bids: [{ price: 99_999, size: 20 }],
    asks: [{ price: 100_001, size: 20 }],
  },
  regime: {
    direction: 'bull', volatility: 'normal', liquidity: 'deep', positioning: 'neutral',
    event: 'normal', directionalScore: 40, volatilityPercentile: 50,
  },
  feed: {
    healthy: true,
    derivativesHealthy: true,
    referenceVenue: 'TEST-BTC-PERP',
    referenceAgeMs: 10,
    coinbaseAgeMs: 10,
    krakenAgeMs: 10,
    spreadBps: 0.2,
    markIndexBps: 0,
    crossVenueBps: 0.2,
    recentSequenceGap: false,
    blockers: [],
  },
};

function candidate(overrides: Partial<StrategyCandidate> = {}): StrategyCandidate {
  return {
    id: 'test-candidate',
    strategyId: 'test-strategy',
    strategyVersion: '1.0.0',
    strategyName: 'Test Strategy',
    mode: 'actionable',
    direction: 'long',
    setupType: 'test',
    createdAt: context.timestamp,
    entryMethod: 'retest',
    preferredEntry: 100_000,
    entryZoneLow: 99_990,
    entryZoneHigh: 100_010,
    doNotChasePrice: 100_050,
    expiresAt: context.timestamp + 60_000,
    structuralStop: 99_950,
    initialTarget: 100_600,
    extendedTarget: 101_000,
    maximumRealisticTarget: 102_000,
    minimumRR: 3,
    strategyLeverageCap: 50,
    expectedHoldingMinutes: 60,
    exitModel: 'partial_runner',
    scores: { signal: 90, regime: 90, execution: 90, data: 100 },
    invalidationReasons: [],
    rationale: ['test'],
    features: {},
    ...overrides,
  };
}

test('BTC strategy registry contains seven unique versioned strategies', () => {
  assert.equal(BTC_STRATEGIES.length, 7);
  assert.equal(new Set(BTC_STRATEGIES.map(strategy => strategy.id)).size, 7);
  for (const strategy of BTC_STRATEGIES) {
    assert.ok(strategy.version.length > 0);
    assert.ok(strategy.leverageCap >= 1 && strategy.leverageCap <= 50);
  }
});

test('risk solver never exceeds 50x and clears net target and reward-to-risk gates', () => {
  const plan = solveRiskPlan(context, candidate());
  assert.equal(plan.approved, true, plan.rejectionReasons.join('; '));
  assert.ok(plan.leverage >= 1 && plan.leverage <= 50);
  assert.ok(plan.estimatedRewardUsd >= 20);
  assert.ok(plan.estimatedNetRR >= 3);
  assert.ok(plan.estimatedRiskUsd <= 20 / 3 + 1e-6);
  assert.ok(plan.liquidationBufferPct > 0);
});

test('risk solver rejects a structural stop that cannot fit the planned loss budget', () => {
  const plan = solveRiskPlan(context, candidate({ structuralStop: 97_000, maximumRealisticTarget: 120_000 }));
  assert.equal(plan.approved, false);
  assert.ok(plan.rejectionReasons.length > 0);
});

test('strategy-specific leverage cap is enforced independently of the platform ceiling', () => {
  const plan = solveRiskPlan(context, candidate({ strategyLeverageCap: 12 }));
  assert.equal(plan.approved, true, plan.rejectionReasons.join('; '));
  assert.ok(plan.leverage <= 12);
});
