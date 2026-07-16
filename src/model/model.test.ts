import test from 'node:test';
import assert from 'node:assert/strict';
import { adminKeyMatches } from '../api/security';
import { aggregateEntityGraph } from './entity-graph';
import { burstFeatures } from './burst';
import { alphaScore, competingRiskHazards } from './ensemble';
import { buildSignalFeatures, flowEvidenceReady, graphEvidenceReady } from './features';
import { assessPromotion, PROMOTION_THRESHOLDS, PromotionSample } from './promotion';
import { classifyRegime } from './regime';
import { observationKeys } from './observations';
import { rankVector, trainPairwiseRanker } from './rank-learner';
import { MarketRegime, SignalFeatureVector, TokenRecord } from '../types';

const regime: MarketRegime = {
  id: 'test:normal', kind: 'normal', observedAt: Date.now(), launches1h: 800,
  passRate: 0.3, medianChange5m: 2, aggregateBuyRatio: 1.2, medianLiquidityUsd: 20_000,
  routeHealth: 0.8, changeProbability: 0.1, completeness: 1,
};
const good: SignalFeatureVector = {
  ageMinutes: 3, curveProgress: 0.45, curveSpeed1m: 0.9, curveSpeed3m: 0.8,
  capitalEfficiency: 0.9, liquidityDepth: 0.8, buyPressure: 0.8, organicBreadth: 0.9,
  smartMoney: 0.7, socialCredibility: 0.7, earlyRetention: 0.9, buyerIndependence: 0.9,
  graphRisk: 0.05, commonFunderPct: 0.05, burstQuality: 0.9, burstExhaustion: 0.1,
  walletEntropy: 0.9, flowRetention: 0.85, tradeAcceleration: 0.8, runupPenalty: 0.05,
  deployerRisk: 0.1, routePrior: 0.9, featureCompleteness: 1, sourceEligible: 1,
};
const bad: SignalFeatureVector = {
  ...good, curveSpeed1m: 0.1, curveSpeed3m: 0.1, capitalEfficiency: 0.1,
  organicBreadth: 0.1, buyPressure: 0.2, smartMoney: 0, buyerIndependence: 0.15,
  graphRisk: 0.9, burstQuality: 0.1, burstExhaustion: 0.9, walletEntropy: 0.1,
  flowRetention: 0.1, tradeAcceleration: 0.1, runupPenalty: 0.9, deployerRisk: 0.9, routePrior: 0.2,
};

function aggregateToken(now = Date.now()): TokenRecord {
  return {
    ca: 'aggregate-test', symbol: 'AGG', name: 'Aggregate', creator: null, source: 'pumpfun',
    firstSeen: now - 3 * 60_000, deployerRep: null, gradAt: null, gradPeak: 0, gradTrough: 0,
    fillMinutes: null, secondWaveAt: null, priceUsd: 0.0001, liquidityUsd: 15_000, mcapUsd: 60_000,
    vol5m: 20_000, buys5m: 18, sells5m: 4, priceChange5m: 8, pairAddress: null,
    dex: 'pumpfun', curveSol: 42, curveSamples: [{ sol: 38, at: now - 60_000 }, { sol: 42, at: now }],
    uniqueBuyers: [], devBuyPct: 0, totalBuys: 0, totalSells: 0, recentTrades: [],
    earlyBuyers: [], earlyExited: [], peakCurveSol: 42,
    socials: { x: true, tg: true, web: false, fetched: true, tgMembers: 300 },
    description: null, boostAmount: 0, tgSamples: [], tgGrowthPerMin: 0,
    aiConviction: null, playType: null, laddersFired: [], triggeredAt: null, triggerPrice: null,
    insiderKilled: false, convictionAt: null, dexId: 'pumpfun', gated: true, gateFailReason: null,
    score: 60, peakScore: 60, firstScorePrice: 0.00009,
    subs: { freshness: 1, liquidity: 1, buyPressure: 1, holderGrowth: 1, smartMoney: 0,
      raw: { freshness: 1, velocity: 1, buy_pressure: 1, organic: 1, social: 1, smart_money: 0 } },
    uniqueBuyerSamples: [4, 9, 18], bundle: null, entityGraph: null,
    modelDecision: null, modelDecisionAt: null, aiNote: null, smartHits: [], ai: null,
    state: 'HEATING', stateChangedAt: now, lastAlertScore: 0,
  };
}

test('high-quality features improve target hazards and alpha rank', () => {
  const high = competingRiskHazards(good, regime);
  const low = competingRiskHazards(bad, regime);
  assert.ok(high.target_2x + high.target_3x > low.target_2x + low.target_3x);
  assert.ok(high.rug < low.rug);
  assert.ok(alphaScore(good, regime) > alphaScore(bad, regime));
});

test('pairwise rank learning orders later winners and beats directional placebo', () => {
  const rows = Array.from({ length: 120 }, (_, group) => [
    { at: group * 2, group: `cohort-${group}`, multiple: 2.5, vector: rankVector(good) },
    { at: group * 2 + 1, group: `cohort-${group}`, multiple: 0.6, vector: rankVector(bad) },
  ]).flat();
  const trained = trainPairwiseRanker(rows.slice(0, 180), rows.slice(180));
  assert.ok(trained.trainPairs >= 90);
  assert.ok(trained.validationPairs >= 30);
  assert.ok(trained.validationAccuracy > 0.9);
  assert.ok(trained.validationAccuracy > trained.placeboAccuracy + 0.3);
});

test('admin keys use constant-length digest comparison and reject blanks', () => {
  assert.equal(adminKeyMatches('correct horse battery staple', 'correct horse battery staple'), true);
  assert.equal(adminKeyMatches('wrong', 'correct horse battery staple'), false);
  assert.equal(adminKeyMatches('', 'correct horse battery staple'), false);
});

test('promotion requires executable scale, holdout lift, regime coverage and falsification', () => {
  const samples: PromotionSample[] = [];
  for (let index = 0; index < PROMOTION_THRESHOLDS.minResolvedExecutable; index++) {
    samples.push({
      signal: 'model_executable', entryAt: index, multiple: index % 5 === 0 ? 3.1 : 1.25,
      verifiedTarget: index % 5 === 0, regime: index % 2 ? 'normal' : 'hot',
    });
    samples.push({
      signal: 'bb_smart', entryAt: index, multiple: index % 10 === 0 ? 3.0 : 1.05,
      verifiedTarget: index % 10 === 0, regime: index % 2 ? 'normal' : 'hot',
    });
  }
  const assessment = assessPromotion(samples, true);
  assert.equal(assessment.ready, true);
  assert.ok((assessment.modelTargetRate || 0) > (assessment.incumbentTargetRate || 0));

  const coldStart = assessPromotion(samples.slice(0, 40), true);
  assert.equal(coldStart.ready, false);
  assert.ok(coldStart.reasons.some(reason => reason.includes('model executable samples')));

  const failedPlacebo = assessPromotion(samples, false);
  assert.equal(failedPlacebo.ready, false);
  assert.ok(failedPlacebo.reasons.some(reason => reason.includes('placebo')));
});

test('shared funding roots collapse wallets into one risky economic entity', () => {
  const buyers = Array.from({ length: 6 }, (_, index) => ({ wallet: `w${index}`, tokenAmount: 20_000_000 }));
  const shared = aggregateEntityGraph({
    buyers,
    nodes: buyers.map((buyer, index) => ({ wallet: buyer.wallet, tokenAmount: buyer.tokenAmount,
      root: index < 5 ? 'same-root' : buyer.wallet, immediateFunder: index < 5 ? 'same-root' : null,
      fundedAt: Date.now() - index * 1_000, firstActivityAt: Date.now() - 3_600_000,
      fundingAmountSol: 1, fundingSource: 'wallet', confidence: 0.9 })),
    deployer: null, totalSupply: 1_000_000_000,
  });
  assert.equal(shared.independentEntities, 2);
  assert.ok(shared.commonFunderBuyerPct > 0.8);
  assert.ok(shared.graphRisk > 0.5);
});

test('event-time model penalizes synchronized repeated-wallet churn', () => {
  const now = Date.now();
  const concentrated = { recentTrades: Array.from({ length: 20 }, (_, index) => ({ at: now - index * 300, buy: index < 15,
    wallet: `bot-${index % 2}`, solAmount: 0.1 })) } as TokenRecord;
  const broad = { recentTrades: Array.from({ length: 20 }, (_, index) => ({ at: now - index * 8_000, buy: index < 18,
    wallet: `human-${index}`, solAmount: 0.1 })) } as TokenRecord;
  const churn = burstFeatures(concentrated, now);
  const organic = burstFeatures(broad, now);
  assert.ok(churn.exhaustion > organic.exhaustion);
  assert.ok(organic.walletEntropy > churn.walletEntropy);
});

test('aggregate flow fallback supplies honest shadow features without inventing wallets', () => {
  const token = aggregateToken();
  const burst = burstFeatures(token);
  assert.equal(burst.tradeCount, 22);
  assert.equal(burst.uniqueWallets, 18);
  assert.equal(burst.interarrivalMeanSeconds, 0);
  assert.ok(burst.completeness > 0.35);
  assert.ok(burst.quality > 0);
  assert.equal(flowEvidenceReady(token), true);
});

test('unknown graph evidence is neutral for shadow ranking but not execution-ready', () => {
  const token = aggregateToken();
  const features = buildSignalFeatures(token, regime);
  assert.equal(graphEvidenceReady(token), false);
  assert.equal(features.graphRisk, 0.5);
  assert.equal(features.buyerIndependence, 0.5);
});

test('regime classifier identifies adverse and mania states', () => {
  assert.equal(classifyRegime({ launches1h: 1000, passRate: 0.3, medianChange5m: -15,
    aggregateBuyRatio: 0.6, medianLiquidityUsd: 10_000, routeHealth: 0.8, completeness: 1 }), 'adverse');
  assert.equal(classifyRegime({ launches1h: 3000, passRate: 0.4, medianChange5m: 10,
    aggregateBuyRatio: 1.7, medianLiquidityUsd: 30_000, routeHealth: 0.9, completeness: 1 }), 'mania');
});

test('observations record the highest reached milestone without retrofilling lower states', () => {
  const keys = observationKeys(1.2, 0.51);
  assert.ok(keys.includes('age_1m'));
  assert.ok(keys.includes('curve_50pct'));
  assert.equal(keys.includes('curve_25pct'), false);
});
