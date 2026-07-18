import test from 'node:test';
import assert from 'node:assert/strict';
import { checkConviction, hasStrongOrganicConfirmation } from './conviction';
import { MarketRegime, SignalDecision, SignalFeatureVector, TokenRecord } from '../types';
import { MODEL_VERSION } from '../model/version';

const now = Date.now();
const regime: MarketRegime = {
  id: 'test:normal', kind: 'normal', observedAt: now, launches1h: 100,
  passRate: 0.2, medianChange5m: 1, aggregateBuyRatio: 1.5,
  medianLiquidityUsd: 20_000, routeHealth: 0.8, changeProbability: 0.1, completeness: 1,
};
const decision: SignalDecision = {
  modelVersion: MODEL_VERSION,
  evaluatedAt: now - 10_000,
  expiresAt: now + 60_000,
  allow: false,
  preliminaryPass: true,
  reasons: ['execution:simulation_wallet_missing'],
  regime,
  features: { featureCompleteness: 0.8 } as SignalFeatureVector,
  hazards: { target_1_5x: 0.1, target_2x: 0.1, target_3x: 0.05, stop_30pct: 0.1,
    stop_50pct: 0.05, rug: 0.02, route_loss: 0.03, timeout: 0.55 },
  targetBeforeStopProbability: 0.18,
  downsideProbability: 0.25,
  expectedValue: 0.15,
  uncertainty: 0.2,
  alphaScore: 0.8,
  cohortPercentile: 0.95,
  cohortSize: 20,
  execution: null,
};

function token(overrides: Partial<TokenRecord> = {}): TokenRecord {
  return {
    ca: 'conviction-test', symbol: 'TEST', name: 'Test', creator: null, source: 'pumpfun',
    firstSeen: now - 5 * 60_000, deployerRep: null, gradAt: null, gradPeak: 0, gradTrough: 0,
    fillMinutes: null, secondWaveAt: null, priceUsd: 1.5, liquidityUsd: 20_000, mcapUsd: 80_000,
    vol5m: 10_000, buys5m: 24, sells5m: 6, priceChange5m: 8, pairAddress: null, dex: 'raydium',
    curveSol: 0, curveSamples: [], uniqueBuyers: Array.from({ length: 20 }, (_, i) => `w${i}`),
    devBuyPct: 2, totalBuys: 24, totalSells: 6, recentTrades: [],
    earlyBuyers: Array.from({ length: 8 }, (_, i) => `e${i}`), earlyExited: ['e0'], peakCurveSol: 0,
    socials: { x: true, tg: false, web: false, fetched: true, tgMembers: null }, description: null,
    boostAmount: 0, tgSamples: [], tgGrowthPerMin: 0, aiConviction: null, playType: null,
    laddersFired: [], triggeredAt: now - 60_000, triggerPrice: 1, insiderKilled: false,
    convictionAt: null, dexId: null, gated: true, gateFailReason: null, score: 70, peakScore: 72,
    firstScorePrice: 0.2, subs: { freshness: 0, liquidity: 0, buyPressure: 0, holderGrowth: 0, smartMoney: 0 },
    uniqueBuyerSamples: [], bundle: { insiderPct: 4, slot0Buyers: 0, fundedSnipers: 0, clusterPct: 5 },
    entityGraph: null, modelDecision: decision, modelDecisionAt: now - 10_000,
    aiNote: null, smartHits: [], ai: null, state: 'TRIGGER', stateChangedAt: now - 60_000, lastAlertScore: 0,
    ...overrides,
  } as TokenRecord;
}

test('strong organic flow can substitute for a missing smart-wallet hit', () => {
  assert.equal(hasStrongOrganicConfirmation(token()), true);
  assert.equal(hasStrongOrganicConfirmation(token({ buys5m: 12, sells5m: 12, totalBuys: 12, totalSells: 12 })), false);
});

test('shadow-mode conviction does not deadlock on missing transaction simulation', () => {
  const result = checkConviction(token(), now);
  assert.equal(result.pass, true, result.missing.join('; '));
  assert.equal(result.missing.some(reason => reason.includes('simulated')), false);
});

test('conviction run-up is measured from the trigger entry, not first score', () => {
  const result = checkConviction(token(), now);
  assert.equal(result.confirmed.some(reason => reason.includes('since trigger')), true);
});

test('a token that runs too far after the trigger is still rejected as late', () => {
  const result = checkConviction(token({ priceUsd: 2 }), now);
  assert.equal(result.pass, false);
  assert.equal(result.missing.some(reason => reason.includes('since trigger')), true);
});
