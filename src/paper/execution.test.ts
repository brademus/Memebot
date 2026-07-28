import test from 'node:test';
import { executionSettings } from './execution';
import { setSolUsd } from '../state/sol-price';
import assert from 'node:assert/strict';
import { TokenRecord } from '../types';
import { executionVenue, quoteExecutableEntry, quoteExecutableExit } from './execution';

const token = { ca: '7YttLkHDo6NEQv7YQwKkK8uZZzYxqkZQ2u4xJr6pump', liquidityUsd: 100_000 } as TokenRecord;
const originalFetch = globalThis.fetch;
const original = {
  key: process.env.JUPITER_API_KEY,
  wallet: process.env.SIMULATION_WALLET,
  rpc: process.env.SOLANA_RPC_URL,
};

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  restore('JUPITER_API_KEY', original.key);
  restore('SIMULATION_WALLET', original.wallet);
  restore('SOLANA_RPC_URL', original.rpc);
});

function configure() {
  setSolUsd(100);   // probes fail closed without a fresh SOL price
  process.env.JUPITER_API_KEY = 'test-key';
  process.env.SIMULATION_WALLET = '11111111111111111111111111111111';
  process.env.SOLANA_RPC_URL = 'https://rpc.test';
}
function quote(overrides: Record<string, unknown> = {}) {
  return {
    inUsdValue: 10, outUsdValue: 9.8, outAmount: '1000000', otherAmountThreshold: '985000',
    priceImpact: -0.01, slippageBps: 150, signatureFeeLamports: 5000,
    prioritizationFeeLamports: 5000, rentFeeLamports: 0, router: 'metis', mode: 'manual',
    transaction: 'A'.repeat(100), ...overrides,
  };
}
function simulatedFetch(overrides: Record<string, unknown> = {}) {
  return async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('api.jup.ag')) return new Response(JSON.stringify(quote(overrides)), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ jsonrpc: '2.0', result: { value: { err: null, unitsConsumed: 123456 } } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

test('marks a signal ineligible when the Jupiter API key is absent', async () => {
  setSolUsd(100);   // isolate the key check: sizing prerequisite satisfied
  delete process.env.JUPITER_API_KEY;
  const result = await quoteExecutableEntry(token, 0.00001);
  assert.equal(result.eligible, false);
  assert.equal(result.status, 'jupiter_api_key_missing');
});

test('routes pre-graduation Pump.fun entries to the curve adapter, never Jupiter', async () => {
  configure();
  let jupiterCalls = 0;
  globalThis.fetch = async (url: any) => {
    if (String(url).includes('jup.ag')) { jupiterCalls++; throw new Error('jupiter must not be asked to route curve tokens'); }
    throw new Error('curve build unavailable in this test');
  };
  const previousWallet = process.env.SIMULATION_WALLET;
  delete process.env.SIMULATION_WALLET;
  delete process.env.EXECUTION_SHADOW_PUBKEY;
  try {
    const pregrad = { ...token, dex: 'pumpfun', gradAt: null } as TokenRecord;
    assert.equal(executionVenue(pregrad), 'pumpfun_curve');
    const result = await quoteExecutableEntry(pregrad, 0.00001);
    assert.equal(result.eligible, false);
    // typed prerequisite from the curve adapter, not a Jupiter status
    assert.equal(result.status, 'curve_shadow_wallet_missing');
    assert.equal(jupiterCalls, 0);
  } finally {
    if (previousWallet === undefined) delete process.env.SIMULATION_WALLET; else process.env.SIMULATION_WALLET = previousWallet;
  }
});

test('requires a simulation wallet for executable evidence', async () => {
  process.env.JUPITER_API_KEY = 'test-key';
  delete process.env.SIMULATION_WALLET;
  const result = await quoteExecutableEntry(token, 0.00001);
  assert.equal(result.eligible, false);
  assert.equal(result.status, 'simulation_wallet_missing');
});

test('builds and simulates multiple sizes before approving entry', async () => {
  configure();
  globalThis.fetch = simulatedFetch();
  const mark = 0.00001;
  const result = await quoteExecutableEntry(token, mark);
  assert.equal(result.eligible, true);
  assert.equal(result.status, 'executable_simulated');
  assert.equal(result.transactionBuilt, true);
  assert.equal(result.simulationOk, true);
  assert.ok(result.probeSizes.length >= 3);
  assert.ok((result.effectiveEntryPrice || 0) > mark);
  assert.equal(result.router, 'metis');
  assert.ok((result.executionScore || 0) >= 0.65);
});

test('rejects a route whose transaction cannot be built', async () => {
  configure();
  globalThis.fetch = simulatedFetch({ transaction: null });
  const result = await quoteExecutableEntry(token, 0.00001);
  assert.equal(result.eligible, false);
  assert.equal(result.status, 'transaction_not_built');
});

test('rejects excessive quoted price impact even when simulation passes', async () => {
  configure();
  globalThis.fetch = simulatedFetch({ priceImpact: -0.2 });
  const result = await quoteExecutableEntry(token, 0.00001);
  assert.equal(result.eligible, false);
  assert.equal(result.status, 'price_impact_too_high');
});

test('builds and simulates liquidation of the exact entry token amount', async () => {
  configure();
  globalThis.fetch = simulatedFetch({
    inUsdValue: 31, outUsdValue: 30.5, outAmount: '200000000', otherAmountThreshold: '197000000',
    priceImpact: -0.02, router: 'jupiterz',
  });
  const result = await quoteExecutableExit(token.ca, '1000000');
  assert.equal(result.eligible, true);
  assert.equal(result.status, 'executable_exit_simulated');
  assert.equal(result.transactionBuilt, true);
  assert.equal(result.simulationOk, true);
  assert.ok((result.proceedsUsd || 0) > 29);
});

function restore(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
}

test('probe size derives from the intended $100 notional at the live SOL price', async () => {
  const { setSolUsd } = await import('../state/sol-price');
  setSolUsd(80);
  assert.equal(executionSettings.intendedNotionalUsd, 100);
  assert.equal(executionSettings.positionSol, 1.25);   // $100 / $80
  setSolUsd(20_000);                                   // absurd price → clamped floor
  assert.equal(executionSettings.positionSol, 0.02);
});
