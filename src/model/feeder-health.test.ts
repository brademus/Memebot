import test from 'node:test';
import assert from 'node:assert/strict';
import { burstFeatures } from './burst';
import { aggregateEntityGraph } from './entity-graph';
import { buildSignalFeatures, flowEvidenceReady, graphEvidenceReady } from './features';
import { MarketRegime, TokenRecord } from '../types';

const regime: MarketRegime = {
  id: 'test:normal', kind: 'normal', observedAt: Date.now(), launches1h: 800,
  passRate: 0.3, medianChange5m: 2, aggregateBuyRatio: 1.2,
  medianLiquidityUsd: 20_000, routeHealth: 0.8, changeProbability: 0.1, completeness: 1,
};

test('reconstructed broad trades satisfy event-time completeness', () => {
  const now = Date.now();
  const token = {
    recentTrades: Array.from({ length: 24 }, (_, index) => ({
      at: now - index * 8_000,
      buy: index < 20,
      wallet: `wallet-${index}`,
      solAmount: 0.15,
    })),
  } as TokenRecord;
  const burst = burstFeatures(token, now);
  assert.ok(burst.completeness >= 0.5);
  assert.ok(burst.walletEntropy > 0.7);
});

test('three independently funded buyers produce a complete low-risk entity graph', () => {
  const buyers = ['a', 'b', 'c'].map(wallet => ({ wallet, tokenAmount: 10_000_000 }));
  const graph = aggregateEntityGraph({
    buyers,
    nodes: buyers.map((buyer, index) => ({
      ...buyer,
      root: `root-${index}`,
      immediateFunder: `root-${index}`,
      fundedAt: Date.now() - index * 60_000,
      firstActivityAt: Date.now() - 2 * 86_400_000,
      fundingAmountSol: 1,
      fundingSource: 'wallet',
      confidence: 0.9,
    })),
    deployer: 'deployer',
    totalSupply: 1_000_000_000,
  });
  assert.equal(graph.complete, true);
  assert.equal(graph.independenceRatio, 1);
  assert.ok(graph.graphRisk < 0.35);
});

test('aggregate market flow is usable while wallet-level graph evidence remains unavailable', () => {
  const now = Date.now();
  const token = {
    ca: 'aggregate', symbol: 'AGG', name: 'Aggregate', creator: null, source: 'pumpfun',
    firstSeen: now - 3 * 60_000, deployerRep: null, gradAt: null, gradPeak: 0, gradTrough: 0,
    fillMinutes: null, secondWaveAt: null, priceUsd: 0.0001, liquidityUsd: 15_000, mcapUsd: 60_000,
    vol5m: 20_000, buys5m: 18, sells5m: 4, priceChange5m: 8, pairAddress: null,
    dex: 'pumpfun', dexId: 'pumpfun', curveSol: 42,
    curveSamples: [{ sol: 38, at: now - 60_000 }, { sol: 42, at: now }],
    uniqueBuyers: [], uniqueBuyerSamples: [4, 9, 18], devBuyPct: 0,
    totalBuys: 0, totalSells: 0, recentTrades: [], earlyBuyers: [], earlyExited: [], peakCurveSol: 42,
    socials: { x: true, tg: true, web: false, fetched: true, tgMembers: 300 },
    description: null, boostAmount: 0, tgSamples: [], tgGrowthPerMin: 0,
    aiConviction: null, playType: null, laddersFired: [], triggeredAt: null, triggerPrice: null,
    insiderKilled: false, convictionAt: null, gated: true, gateFailReason: null,
    score: 60, peakScore: 60, firstScorePrice: 0.00009,
    subs: { freshness: 1, liquidity: 1, buyPressure: 1, holderGrowth: 1, smartMoney: 0,
      raw: { freshness: 1, velocity: 1, buy_pressure: 1, organic: 1, social: 1, smart_money: 0 } },
    bundle: null, entityGraph: null, modelDecision: null, modelDecisionAt: null,
    aiNote: null, smartHits: [], ai: null, state: 'HEATING', stateChangedAt: now, lastAlertScore: 0,
  } as TokenRecord;
  const features = buildSignalFeatures(token, regime, now);
  assert.equal(flowEvidenceReady(token, now), true);
  assert.equal(graphEvidenceReady(token), false);
  assert.equal(features.graphRisk, 0.5);
  assert.equal(features.buyerIndependence, 0.5);
});
