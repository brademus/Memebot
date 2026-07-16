import test from 'node:test';
import assert from 'node:assert/strict';
import { burstFeatures } from './burst';
import { aggregateEntityGraph } from './entity-graph';
import { TokenRecord } from '../types';

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
