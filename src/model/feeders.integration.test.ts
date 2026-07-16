import test from 'node:test';
import assert from 'node:assert/strict';
import { burstFeatures } from './burst';
import { flowEvidenceReady, graphEvidenceReady } from './features';
import { TokenRecord } from '../types';

test('lite-mode aggregate flow is usable without masquerading as wallet events', () => {
  const token = {
    recentTrades: [], buys5m: 20, sells5m: 5, vol5m: 30_000,
    uniqueBuyers: [], uniqueBuyerSamples: [3, 8, 20], priceChange5m: 10,
    entityGraph: null, bundle: null,
  } as TokenRecord;
  const burst = burstFeatures(token);
  assert.equal(burst.tradeCount, 25);
  assert.equal(burst.interarrivalMeanSeconds, 0);
  assert.ok(burst.completeness > 0.35);
  assert.equal(flowEvidenceReady(token), true);
  assert.equal(graphEvidenceReady(token), false);
});
