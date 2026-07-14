import test from 'node:test';
import assert from 'node:assert/strict';
import { updateState } from './states';
import { MarketRegime, SignalDecision, SignalFeatureVector, TokenRecord } from '../types';
import { MODEL_VERSION } from '../model/version';

const regime: MarketRegime = { id: 'test:normal', kind: 'normal', observedAt: Date.now(), launches1h: 500,
  passRate: 0.3, medianChange5m: 1, aggregateBuyRatio: 1.2, medianLiquidityUsd: 20_000,
  routeHealth: 0.9, changeProbability: 0.1, completeness: 1 };
const features = { featureCompleteness: 1 } as SignalFeatureVector;
function allowedDecision(): SignalDecision {
  return {
    modelVersion: MODEL_VERSION, evaluatedAt: Date.now(), expiresAt: Date.now() + 60_000,
    allow: true, preliminaryPass: true, reasons: [], regime, features,
    hazards: { target_1_5x: 0.1,target_2x: 0.1,target_3x: 0.05,stop_30pct: 0.1,stop_50pct: 0.05,rug: 0.02,route_loss: 0.03,timeout: 0.55 },
    targetBeforeStopProbability: 0.15, downsideProbability: 0.2, expectedValue: 0.2,
    uncertainty: 0.1, alphaScore: 0.8, cohortPercentile: 0.95, cohortSize: 20,
    execution: { eligible: true,status: 'executable_simulated',transactionBuilt: true,simulationOk: true,
      simulationError: null,executionScore: 0.9,routeStabilityBps: 10,requestedPositionSol: 0.1,
      selectedRouter: 'test',selectedMode: 'manual',priceImpact: 0.01,unitsConsumed: 100,probeSizes: [] },
  };
}
function token(overrides: Partial<TokenRecord> = {}): TokenRecord {
  return {
    ca: 'test', symbol: 'TEST', name: 'Test', creator: null, source: 'pumpfun',
    firstSeen: Date.now() - 5 * 60_000, state: 'WATCHING', stateChangedAt: Date.now() - 2 * 60_000,
    score: 70, peakScore: 70, firstScorePrice: 1, priceUsd: 1, buys5m: 12, sells5m: 3,
    totalBuys: 20, totalSells: 3, uniqueBuyers: Array.from({ length: 15 }, (_, i) => `wallet-${i}`),
    triggeredAt: null, insiderKilled: false, dex: 'raydium', peakCurveSol: 0, curveSol: 0,
    modelDecision: allowedDecision(), modelDecisionAt: Date.now(), ...overrides,
  } as TokenRecord;
}

test('promotes only a persistent evidence-backed v3-approved token to trigger', () => {
  assert.equal(updateState(token()), 'TRIGGER');
});
test('abstains when the v3 decision is absent', () => {
  assert.equal(updateState(token({ modelDecision: null, modelDecisionAt: null })), 'HEATING');
});
test('keeps momentum-source tokens measurable but out of recommendations', () => {
  const candidate = token({ source: 'momentum' });
  assert.equal(updateState(candidate), 'HEATING');
});
test('classifies an uncalled 40 percent runner as extended before promotion', () => {
  assert.equal(updateState(token({ priceUsd: 1.5 })), 'EXTENDED');
});
test('does not eject an already-triggered winner for becoming extended', () => {
  const candidate = token({ state: 'TRIGGER', triggeredAt: Date.now() - 60_000, priceUsd: 1.5 });
  assert.equal(updateState(candidate), null);
  assert.equal(candidate.state, 'TRIGGER');
});
test('death conditions take precedence over model approval', () => {
  assert.equal(updateState(token({ insiderKilled: true })), 'DYING');
});
