import assert from 'node:assert/strict';
import test from 'node:test';
import { solveRiskPlan } from './risk';
import { BTC_STRATEGIES } from './strategy-registry';
import { MarketContext, StrategyCandidate, StrategyPerformance } from './types';

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
    entryZoneLow: 99_950,
    entryZoneHigh: 100_050,
    doNotChasePrice: 100_150,
    expiresAt: context.timestamp + 60_000,
    structuralStop: 99_500,
    initialTarget: 101_600,
    extendedTarget: 102_500,
    maximumRealisticTarget: 103_000,
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

function evidence(overrides: Partial<StrategyPerformance> = {}): StrategyPerformance {
  return {
    strategyId: 'test-strategy',
    strategyVersion: '1.0.0',
    strategyName: 'Test Strategy',
    mode: 'actionable',
    leverageCap: 50,
    activeCalls: 0,
    totalCalls: 40,
    wins: 22,
    losses: 18,
    winRatePct: 55,
    netPnlUsd: 80,
    averageR: 0.25,
    profitFactor: 1.3,
    ...overrides,
  };
}

test('BTC strategy registry contains twenty-seven unique versioned strategies', () => {
  // 17 pre-wave-3 (10 actionable-mode, 7 shadow) + the 10 wave-3 shadow
  // research strategies added 2026-07-31.
  assert.equal(BTC_STRATEGIES.length, 27);
  assert.equal(new Set(BTC_STRATEGIES.map(strategy => strategy.id)).size, 27);
  assert.equal(BTC_STRATEGIES.filter(strategy => strategy.mode === 'actionable').length, 10);
  assert.equal(BTC_STRATEGIES.filter(strategy => strategy.mode === 'shadow').length, 17);
  for (const strategy of BTC_STRATEGIES) {
    assert.ok(strategy.version.length > 0);
    assert.ok(strategy.leverageCap >= 1 && strategy.leverageCap <= 50);
  }
});

test('standard actionable policy uses native target, 6% projected ROI, 2.25R and a $6 loss budget', () => {
  const plan = solveRiskPlan(context, candidate(), evidence());
  assert.equal(plan.approved, true, plan.rejectionReasons.join('; '));
  assert.equal(plan.targetPrice, 101_600);
  assert.equal(plan.actionableTier, 'standard');
  assert.ok(plan.leverage >= 1 && plan.leverage <= 50);
  assert.ok(plan.estimatedTargetRoiPct >= 6);
  assert.ok(plan.estimatedNetRR >= 2.25);
  assert.ok(plan.estimatedRiskUsd <= 6 + 1e-6);
  assert.ok(plan.liquidationBufferPct > 0);
  assert.equal(plan.expectancyEvidence?.ready, true);
});

test('A+ policy preserves the 20% projected ROI and 3R premium threshold', () => {
  const plan = solveRiskPlan(context, candidate({ initialTarget: 103_000 }), evidence());
  assert.equal(plan.approved, true, plan.rejectionReasons.join('; '));
  assert.equal(plan.actionableTier, 'a_plus');
  assert.ok(plan.estimatedTargetRoiPct >= 20);
  assert.ok(plan.estimatedNetRR >= 3);
});

test('actionable policy rejects an exact strategy version without mature positive expectancy', () => {
  const plan = solveRiskPlan(context, candidate(), evidence({
    totalCalls: 29,
    wins: 16,
    losses: 13,
    netPnlUsd: 20,
    averageR: 0.2,
    profitFactor: 1.2,
  }));
  assert.equal(plan.approved, false);
  assert.ok(plan.rejectionReasons.some(reason => reason.includes('30 resolved calls')));
});

test('actionable policy rejects negative demonstrated expectancy even with enough samples', () => {
  const plan = solveRiskPlan(context, candidate(), evidence({
    wins: 18,
    losses: 22,
    netPnlUsd: -5,
    averageR: -0.02,
    profitFactor: 0.95,
  }));
  assert.equal(plan.approved, false);
  assert.ok(plan.rejectionReasons.some(reason => reason.includes('net P&L is not positive')));
});

test('risk solver rejects an invalid structural stop beyond the maximum allowed setup distance', () => {
  const plan = solveRiskPlan(context, candidate({ structuralStop: 90_000, maximumRealisticTarget: 140_000 }), evidence());
  assert.equal(plan.approved, false);
  assert.ok(plan.rejectionReasons.some(reason => reason.includes('structural stop distance')));
});

test('strategy-specific leverage cap is enforced independently of the platform ceiling', () => {
  const plan = solveRiskPlan(context, candidate({ strategyLeverageCap: 6, initialTarget: 102_000 }), evidence());
  assert.equal(plan.approved, true, plan.rejectionReasons.join('; '));
  assert.ok(plan.leverage <= 6);
});
