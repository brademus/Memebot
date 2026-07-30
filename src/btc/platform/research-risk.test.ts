import assert from 'node:assert/strict';
import test from 'node:test';
import { solveRiskPlan } from './risk';
import { solveResearchRiskPlan } from './research-risk';
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
    id: 'research-candidate',
    strategyId: 'research-strategy',
    strategyVersion: '0.1.0-shadow',
    strategyName: 'Research Strategy',
    mode: 'shadow',
    direction: 'long',
    setupType: 'native_target_test',
    createdAt: context.timestamp,
    entryMethod: 'market',
    preferredEntry: 100_000,
    entryZoneLow: 99_990,
    entryZoneHigh: 100_010,
    doNotChasePrice: 100_050,
    expiresAt: context.timestamp + 60_000,
    structuralStop: 99_950,
    initialTarget: 100_180,
    extendedTarget: 100_300,
    maximumRealisticTarget: 100_180,
    minimumRR: 3,
    strategyLeverageCap: 50,
    expectedHoldingMinutes: 30,
    exitModel: 'fixed',
    scores: { signal: 90, regime: 90, execution: 90, data: 100 },
    invalidationReasons: [],
    rationale: ['test'],
    features: {},
    ...overrides,
  };
}

test('research can approve a native profitable target that the actionable +$20 and 3R contract rejects', () => {
  const setup = candidate();
  const actionable = solveRiskPlan(context, setup);
  const research = solveResearchRiskPlan(context, setup);
  assert.equal(actionable.approved, false);
  assert.equal(research.approved, true, research.rejectionReasons.join('; '));
  assert.ok(research.estimatedRewardUsd > 0);
  assert.ok(research.estimatedRewardUsd < 20);
  assert.ok(research.leverage >= 1 && research.leverage <= 50);
  assert.ok(research.estimatedRiskUsd <= 20 / 3 + 1e-6);
  assert.ok(research.liquidationBufferPct > 0);
});

test('research uses the nearer maximum-realistic boundary when a raw strategy target overreaches it', () => {
  const research = solveResearchRiskPlan(context, candidate({
    initialTarget: 100_600,
    maximumRealisticTarget: 100_180,
  }));
  assert.equal(research.approved, true, research.rejectionReasons.join('; '));
  assert.equal(research.targetPrice, 100_180);
});

test('research rejects a native target that is not profitable after estimated costs', () => {
  const research = solveResearchRiskPlan(context, candidate({
    initialTarget: 100_050,
    maximumRealisticTarget: 100_050,
  }));
  assert.equal(research.approved, false);
  assert.ok(research.rejectionReasons.some(reason => reason.includes('after estimated costs')));
});

test('research keeps strategy-specific leverage caps and liquidation safety', () => {
  const research = solveResearchRiskPlan(context, candidate({ strategyLeverageCap: 12 }));
  assert.equal(research.approved, true, research.rejectionReasons.join('; '));
  assert.ok(research.leverage <= 12);
  assert.ok(research.liquidationBufferPct > 0);
});
