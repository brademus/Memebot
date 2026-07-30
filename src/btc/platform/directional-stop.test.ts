import assert from 'node:assert/strict';
import test from 'node:test';
import { solveResearchRiskPlan } from './research-risk';
import { solveRiskPlan, stopIsDirectional } from './risk';
import { MarketContext, StrategyCandidate } from './types';

const now = Date.now();
const context: MarketContext = {
  timestamp: now,
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
    nextFundingAt: now + 8 * 60 * 60_000,
    openInterest: 1_000,
    openInterestValue: 100_000_000,
    openInterestChangePct: 0,
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
    direction: 'range',
    volatility: 'normal',
    liquidity: 'deep',
    positioning: 'neutral',
    event: 'normal',
    directionalScore: 0,
    volatilityPercentile: 50,
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
    id: 'directional-stop-candidate',
    strategyId: 'directional-stop-test',
    strategyVersion: '1.0.0',
    strategyName: 'Directional Stop Test',
    mode: 'actionable',
    direction: 'long',
    setupType: 'test',
    createdAt: now,
    entryMethod: 'market',
    preferredEntry: 100_000,
    entryZoneLow: 99_990,
    entryZoneHigh: 100_010,
    doNotChasePrice: 100_050,
    expiresAt: now + 60_000,
    structuralStop: 99_950,
    initialTarget: 100_600,
    extendedTarget: 101_000,
    maximumRealisticTarget: 102_000,
    minimumRR: 3,
    strategyLeverageCap: 50,
    expectedHoldingMinutes: 60,
    exitModel: 'fixed',
    scores: { signal: 90, regime: 90, execution: 90, data: 100 },
    invalidationReasons: [],
    rationale: ['test'],
    features: {},
    ...overrides,
  };
}

test('directional stop invariant requires long stops below entry and short stops above entry', () => {
  assert.equal(stopIsDirectional(100_000, 99_950, 'long'), true);
  assert.equal(stopIsDirectional(100_000, 100_050, 'long'), false);
  assert.equal(stopIsDirectional(100_000, 100_050, 'short'), true);
  assert.equal(stopIsDirectional(100_000, 99_950, 'short'), false);
});

test('actionable solver rejects a wrong-sided structural stop', () => {
  const plan = solveRiskPlan(context, candidate({ structuralStop: 100_050 }));
  assert.equal(plan.approved, false);
  assert.ok(plan.rejectionReasons.some(reason => reason.includes('wrong side')));
});

test('research solver rejects a wrong-sided structural stop', () => {
  const plan = solveResearchRiskPlan(context, candidate({
    mode: 'shadow',
    direction: 'short',
    structuralStop: 99_950,
    initialTarget: 99_700,
    maximumRealisticTarget: 99_700,
  }));
  assert.equal(plan.approved, false);
  assert.ok(plan.rejectionReasons.some(reason => reason.includes('wrong side')));
});
