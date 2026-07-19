import test from 'node:test';
import assert from 'node:assert/strict';
import { assessTrigger, updateState } from './states';
import { ConvictionQueueStatus } from './conviction-queue';
import { MarketRegime, SignalDecision, SignalFeatureVector, TokenRecord } from '../types';
import { MODEL_VERSION } from '../model/version';
import { cfg } from '../config';

const now = Date.now();
const regime: MarketRegime = {
  id: 'test:normal', kind: 'normal', observedAt: now, launches1h: 500,
  passRate: 0.3, medianChange5m: 1, aggregateBuyRatio: 1.2, medianLiquidityUsd: 20_000,
  routeHealth: 0.9, changeProbability: 0.1, completeness: 1,
};
const features = { featureCompleteness: 1 } as SignalFeatureVector;

function allowedDecision(): SignalDecision {
  return {
    modelVersion: MODEL_VERSION, evaluatedAt: now, expiresAt: now + 60_000,
    allow: true, preliminaryPass: true, reasons: [], regime, features,
    hazards: {
      target_1_5x: 0.1, target_2x: 0.1, target_3x: 0.05, stop_30pct: 0.1,
      stop_50pct: 0.05, rug: 0.02, route_loss: 0.03, timeout: 0.55,
    },
    targetBeforeStopProbability: 0.15, downsideProbability: 0.2, expectedValue: 0.2,
    uncertainty: 0.1, alphaScore: 0.8, cohortPercentile: 0.95, cohortSize: 20,
    execution: {
      eligible: true, status: 'executable_simulated', transactionBuilt: true, simulationOk: true,
      simulationError: null, executionScore: 0.9, routeStabilityBps: 10, requestedPositionSol: 0.1,
      selectedRouter: 'test', selectedMode: 'manual', priceImpact: 0.01, unitsConsumed: 100,
      probeSizes: [],
    },
  };
}

function token(overrides: Partial<TokenRecord> = {}): TokenRecord {
  return {
    ca: 'test', symbol: 'TEST', name: 'Test', creator: null, source: 'pumpfun',
    firstSeen: now - 5 * 60_000, state: 'WATCHING', stateChangedAt: now - 2 * 60_000,
    score: 70, peakScore: 70, firstScorePrice: 1, priceUsd: 1, priceChange5m: 10,
    buys5m: 12, sells5m: 3, totalBuys: 20, totalSells: 3,
    uniqueBuyers: Array.from({ length: 15 }, (_, index) => `wallet-${index}`),
    recentTrades: [], earlyBuyers: [], earlyExited: [], curveSamples: [],
    triggeredAt: null, triggerPrice: null, convictionAt: now - 3 * 60_000,
    insiderKilled: false, dex: 'raydium', peakCurveSol: 0, curveSol: 0,
    modelDecision: allowedDecision(), modelDecisionAt: now,
    gated: true, gateFailReason: null, liquidityUsd: 20_000, mcapUsd: 80_000,
    vol5m: 5_000, pairAddress: null, devBuyPct: 2, socials: {
      x: true, tg: false, web: false, fetched: true, tgMembers: null,
    },
    ...overrides,
  } as TokenRecord;
}

function conviction(overrides: Partial<ConvictionQueueStatus> = {}): ConvictionQueueStatus {
  return {
    queued: true,
    lane: 'organic',
    enteredAt: now - 180_000,
    heldSeconds: 180,
    minimumHoldSeconds: 120,
    holdReady: true,
    scoreFloor: 60,
    ...overrides,
  };
}

test('a high-scoring watchlist coin cannot alert before conviction selection', () => {
  const candidate = token({ convictionAt: null });
  const changed = updateState(candidate, now);
  assert.equal(changed, 'HEATING');
  assert.equal(assessTrigger(candidate, now).blockers.includes('not selected for conviction'), true);
});

test('a selected conviction waits through its observation hold', () => {
  const queued = conviction({ heldSeconds: 30, minimumHoldSeconds: 120, holdReady: false });
  const candidate = token();
  assert.equal(updateState(candidate, now, queued), 'HEATING');
  assert.equal(assessTrigger(candidate, now, queued).blockers.some(reason => reason.includes('remaining')), true);
});

test('a conviction alerts only after entry timing clears', () => {
  assert.equal(updateState(token(), now, conviction()), 'TRIGGER');
});

test('aggregate-mode pumpfun evidence can alert when wallet-level events are unavailable', () => {
  const candidate = token({
    dex: 'pumpfun',
    totalBuys: 0,
    totalSells: 0,
    uniqueBuyers: [],
    buys5m: 12,
    sells5m: 3,
    curveSol: 35,
    peakCurveSol: 35,
  });
  const assessment = assessTrigger(candidate, now, conviction());
  assert.equal(assessment.evidenceReady, true);
  assert.equal(updateState(candidate, now, conviction()), 'TRIGGER');
});

test('shadow mode still allows the incumbent lifecycle without a v3 decision', () => {
  assert.equal(updateState(token({ modelDecision: null, modelDecisionAt: null }), now, conviction()), 'TRIGGER');
});

test('an extreme five-minute spike waits instead of producing a chase alert', () => {
  const candidate = token({ priceChange5m: cfg().momentum.max_change5m_pct + 10 });
  const assessment = assessTrigger(candidate, now, conviction());
  assert.equal(assessment.ready, false);
  assert.equal(assessment.blockers.some(reason => reason.includes('too hot to chase')), true);
  assert.equal(updateState(candidate, now, conviction()), 'HEATING');
});

test('qualified fast runners can alert before the extension ceiling', () => {
  const candidate = token({ priceUsd: 1.5 });
  assert.equal(assessTrigger(candidate, now, conviction()).ready, true);
  assert.equal(updateState(candidate, now, conviction()), 'TRIGGER');
});

test('uncalled runners beyond the configured ceiling remain observation-only', () => {
  const price = 1 + (cfg().states.extended_pct + 5) / 100;
  const candidate = token({ priceUsd: price });
  assert.equal(assessTrigger(candidate, now, conviction()).tooLate, true);
  assert.equal(updateState(candidate, now, conviction()), 'EXTENDED');
});

test('an alerted call stays in TRIGGER after leaving the conviction queue', () => {
  const candidate = token({ state: 'TRIGGER', triggeredAt: now - 60_000, triggerPrice: 1, priceUsd: 2 });
  assert.equal(updateState(candidate, now), null);
  assert.equal(candidate.state, 'TRIGGER');
});

test('death conditions take precedence over conviction and timing approval', () => {
  assert.equal(updateState(token({ insiderKilled: true }), now, conviction()), 'DYING');
});
