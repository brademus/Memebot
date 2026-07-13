import test from 'node:test';
import assert from 'node:assert/strict';
import { setSolPrice } from '../ingest/pumpfun';
import { TokenRecord } from '../types';
import { quoteExecutableEntry } from './execution';

const token = {
  ca: '7YttLkHDo6NEQv7YQwKkK8uZZzYxqkZQ2u4xJr6pump',
  liquidityUsd: 100_000,
} as TokenRecord;

const originalFetch = globalThis.fetch;
const originalKey = process.env.JUPITER_API_KEY;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.JUPITER_API_KEY;
  else process.env.JUPITER_API_KEY = originalKey;
});

test('marks a signal ineligible when the Jupiter API key is absent', async () => {
  delete process.env.JUPITER_API_KEY;
  const quote = await quoteExecutableEntry(token, 0.00001);
  assert.equal(quote.eligible, false);
  assert.equal(quote.status, 'jupiter_api_key_missing');
});

test('uses minimum slippage output and fees to make entry price conservative', async () => {
  process.env.JUPITER_API_KEY = 'test-key';
  setSolPrice(100);
  globalThis.fetch = async () => new Response(JSON.stringify({
    inUsdValue: 10,
    outUsdValue: 9.8,
    outAmount: '1000000',
    otherAmountThreshold: '985000',
    priceImpact: -0.01,
    slippageBps: 150,
    signatureFeeLamports: 5000,
    prioritizationFeeLamports: 5000,
    rentFeeLamports: 0,
    router: 'metis',
  }), { status: 200, headers: { 'content-type': 'application/json' } });

  const mark = 0.00001;
  const quote = await quoteExecutableEntry(token, mark);
  assert.equal(quote.eligible, true);
  assert.equal(quote.status, 'executable_quote');
  assert.ok((quote.effectiveEntryPrice || 0) > mark);
  assert.equal(quote.router, 'metis');
  assert.equal(quote.positionSol, 0.1);
});

test('rejects a route whose quoted price impact exceeds the configured maximum', async () => {
  process.env.JUPITER_API_KEY = 'test-key';
  setSolPrice(100);
  globalThis.fetch = async () => new Response(JSON.stringify({
    inUsdValue: 10,
    outUsdValue: 8,
    outAmount: '1000000',
    otherAmountThreshold: '985000',
    priceImpact: -0.2,
    slippageBps: 150,
    router: 'metis',
  }), { status: 200, headers: { 'content-type': 'application/json' } });

  const quote = await quoteExecutableEntry(token, 0.00001);
  assert.equal(quote.eligible, false);
  assert.equal(quote.status, 'price_impact_too_high');
});
