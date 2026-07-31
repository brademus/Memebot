import assert from 'node:assert/strict';
import test from 'node:test';
import { createPaperCall, markPaperCall } from './execution';
import { MarketContext, RiskPlan, StrategyCandidate } from './types';

const baseContext: MarketContext = {
  timestamp: 1_000_000,
  prices: {
    last: 100,
    bid: 99.99,
    ask: 100.01,
    mark: 100,
    index: 100,
    coinbaseSpot: 100,
    krakenSpot: 100,
    consolidatedFair: 100,
  },
  candles: { oneMinute: [], fiveMinute: [], fifteenMinute: [], oneHour: [], fourHour: [] },
  derivatives: {
    fundingRate: 0,
    predictedFundingRate: 0,
    nextFundingAt: null,
    openInterest: 1,
    openInterestValue: 1,
    openInterestChangePct: 0,
    longLiquidationUsd5m: 0,
    shortLiquidationUsd5m: 0,
    basisBps: 0,
  },
  orderFlow: {
    aggressiveBuyUsd1m: 1,
    aggressiveSellUsd1m: 1,
    aggressiveBuyUsd5m: 1,
    aggressiveSellUsd5m: 1,
    topBookImbalance: 0,
    depthImbalance5Bps: 0,
    bookFragility: 0,
    absorptionScore: 0,
    bids: [{ price: 99.99, size: 10 }],
    asks: [{ price: 100.01, size: 10 }],
  },
  regime: {
    direction: 'range', volatility: 'normal', liquidity: 'deep', positioning: 'neutral',
    event: 'normal', directionalScore: 0, volatilityPercentile: 50,
  },
  feed: {
    healthy: true,
    derivativesHealthy: true,
    referenceVenue: 'TEST',
    referenceAgeMs: 0,
    coinbaseAgeMs: 0,
    krakenAgeMs: 0,
    spreadBps: 2,
    markIndexBps: 0,
    crossVenueBps: 0,
    recentSequenceGap: false,
    blockers: [],
  },
};

const candidate: StrategyCandidate = {
  id: 'pnl-test',
  strategyId: 'pnl-test',
  strategyVersion: '1.0.0',
  strategyName: 'PnL Test',
  mode: 'actionable',
  direction: 'long',
  setupType: 'test',
  createdAt: baseContext.timestamp,
  entryMethod: 'market',
  preferredEntry: 100,
  entryZoneLow: 99,
  entryZoneHigh: 101,
  doNotChasePrice: 102,
  expiresAt: baseContext.timestamp + 60_000,
  structuralStop: 99.5,
  initialTarget: 100.2,
  extendedTarget: 110,
  maximumRealisticTarget: 110,
  minimumRR: 2,
  strategyLeverageCap: 10,
  expectedHoldingMinutes: 60,
  exitModel: 'partial_runner',
  scores: { signal: 90, regime: 90, execution: 90, data: 100 },
  invalidationReasons: [],
  rationale: ['test'],
  features: {},
};

const plan: RiskPlan = {
  approved: true,
  rejectionReasons: [],
  marginUsd: 100,
  leverage: 10,
  notionalUsd: 1000,
  entryPrice: 100,
  stopPrice: 99.5,
  targetPrice: 100.2,
  extendedTargetPrice: 110,
  liquidationPrice: 90,
  liquidationBufferPct: 9.5,
  estimatedRiskUsd: 6,
  estimatedRewardUsd: 10,
  estimatedNetRR: 10 / 6,
  estimatedTargetRoiPct: 10,
  actionableTier: 'standard',
  costs: {
    entryFeeUsd: 0.55,
    exitFeeUsd: 0.55,
    entrySlippageUsd: 0.05,
    exitSlippageUsd: 0.06,
    spreadUsd: 0.2,
    expectedFundingUsd: 0,
    totalEstimatedUsd: 1.41,
  },
};

const closeCost = (notional: number) => notional * (0.00055 + (0.8 + 2 * 0.45) / 10_000);
const closeContext = (bid: number): MarketContext => ({
  ...baseContext,
  timestamp: baseContext.timestamp + 30_000,
  prices: { ...baseContext.prices, bid, ask: bid + 0.02, last: bid + 0.01, mark: bid + 0.01 },
});

const near = (actual: number, expected: number, message: string) => {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: expected ${expected}, got ${actual}`);
};

test('BTC open PnL equals executable gross move minus charged and projected costs without charging spread twice', () => {
  const { call, event } = createPaperCall(candidate, plan, baseContext, 'actionable');
  near(call.realizedPnlUsd, -0.60, 'entry charged costs');
  assert.equal(event.fill?.purpose, 'entry');
  near(Number(event.fill?.feeUsd), 0.55, 'entry fill fee');
  near(Number(event.fill?.slippageUsd), 0.05, 'entry fill slippage');
  near(call.feesUsd, 0.60, 'stored charged costs');
  assert.equal(call.features.pnlAccountingVersion, 2);

  const context = closeContext(100.11);
  markPaperCall(call, context);
  const gross = 1000 * (100.11 - 100.01) / 100.01;
  const projected = closeCost(1000);
  near(Number(call.features.grossPnlUsd), gross, 'gross PnL');
  near(Number(call.features.projectedExitCostsUsd), projected, 'projected exit costs');
  near(call.netPnlUsd, gross - 0.60 - projected, 'net PnL');
  near(call.currentR, call.netPnlUsd / 6, 'R uses fixed planned risk');
});

test('BTC partial exit re-marks only the remaining fraction and does not double-count closed PnL', () => {
  const { call } = createPaperCall(candidate, plan, baseContext, 'actionable');
  const context = closeContext(100.50);
  const events = markPaperCall(call, context);
  const partial = events.find(event => event.type === 'partial_take_profit');
  assert.equal(partial?.fill?.purpose, 'partial_exit');
  near(Number(partial?.fill?.fraction), 0.75, 'partial fill fraction');
  near(Number(partial?.fill?.notionalUsd), 750, 'partial fill notional');

  const gross = 1000 * (100.50 - 100.01) / 100.01;
  const chargedEntry = 0.60;
  const chargedPartialExit = closeCost(750);
  const projectedRemainderExit = closeCost(250);
  const expectedNet = gross - chargedEntry - chargedPartialExit - projectedRemainderExit;
  const expectedUnrealized = gross * 0.25 - projectedRemainderExit;

  near(call.remainingFraction, 0.25, 'remaining fraction');
  near(call.unrealizedPnlUsd, expectedUnrealized, 'remaining unrealized PnL');
  near(call.netPnlUsd, expectedNet, 'partial net PnL');
  near(Number(call.features.grossPnlUsd), gross, 'partial gross PnL');
  near(Number(call.features.projectedExitCostsUsd), projectedRemainderExit, 'remaining projected exit costs');
});
