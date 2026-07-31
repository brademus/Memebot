import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyHeliusRequest, decideHeliusRequest } from './helius-free-budget';

test('classifies enhanced address-history at 100 credits, plain RPC at 1', () => {
  assert.deepEqual(
    classifyHeliusRequest('https://api.helius.xyz/v0/addresses/ABC/transactions?api-key=x'),
    { cost: 100, category: 'enhanced_address_history' },
  );
  assert.deepEqual(
    classifyHeliusRequest('https://mainnet.helius-rpc.com/?api-key=x'),
    { cost: 1, category: 'rpc' },
  );
});

test('exhausting the enhanced ceiling does not block RPC — the exact bug found live 2026-07-30', () => {
  // This is the fix: bundle.ts and deployer.ts (insider/bundle detection, the
  // one proven edge) fail OPEN on a Helius error. Before the split, one shared
  // pool meant an enhanced-category leak silently made every token look clean
  // for the rest of the day once RPC calls started getting blocked too.
  const rpcSoFar = 500;
  const enhancedSoFar = 30_000;   // enhanced ceiling fully spent
  const rpcCeiling = 50_000;
  const enhancedCeiling = 30_000;

  const rpcCall = decideHeliusRequest('rpc', 1, rpcSoFar, enhancedSoFar, rpcCeiling, enhancedCeiling);
  assert.equal(rpcCall.allowed, true, 'RPC must keep working when only the enhanced pool is spent');
  assert.equal(rpcCall.scope, 'rpc');

  const enhancedCall = decideHeliusRequest('enhanced_address_history', 100, rpcSoFar, enhancedSoFar, rpcCeiling, enhancedCeiling);
  assert.equal(enhancedCall.allowed, false, 'the enhanced pool itself is genuinely spent');
  assert.equal(enhancedCall.scope, 'enhanced');
});

test('exhausting the RPC ceiling does not block enhanced calls — independence runs both directions', () => {
  const rpcSoFar = 50_000;        // RPC ceiling fully spent
  const enhancedSoFar = 1_000;
  const rpcCeiling = 50_000;
  const enhancedCeiling = 30_000;

  assert.equal(decideHeliusRequest('rpc', 1, rpcSoFar, enhancedSoFar, rpcCeiling, enhancedCeiling).allowed, false);
  assert.equal(decideHeliusRequest('enhanced_tx_parse', 100, rpcSoFar, enhancedSoFar, rpcCeiling, enhancedCeiling).allowed, true,
    'enhanced still has headroom even though RPC is spent');
});

test('a request that would exactly fill a ceiling is allowed; one credit more is not', () => {
  assert.equal(decideHeliusRequest('rpc', 1, 49_999, 0, 50_000, 30_000).allowed, true);
  assert.equal(decideHeliusRequest('rpc', 2, 49_999, 0, 50_000, 30_000).allowed, false);
});

test('webhook-admin calls ride the RPC pool — a spent enhanced budget must not silence wallet tracking', async () => {
  const { decideHeliusRequest, isRpcPoolCategory } = await import('./helius-free-budget');
  assert.equal(isRpcPoolCategory('webhook_admin'), true);
  assert.equal(isRpcPoolCategory('enhanced_address_history'), false);
  const call = decideHeliusRequest('webhook_admin', 1, 100, 30_000, 50_000, 30_000);
  assert.equal(call.allowed, true, 'enhanced fully spent, webhook admin must still work');
  assert.equal(call.scope, 'rpc');
});
