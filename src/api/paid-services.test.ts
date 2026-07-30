import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPaidServicesStatus } from './paid-services';

const healthyOverrides = {
  pumpportal: { effectiveMode: 'full', messages: { lastTradeAt: 'now', tradesReceived: 500 } },
  helius: { configured: true, lastSuccessAt: new Date().toISOString(), lastFailureAt: null, lastError: null },
  gemini: { configured: true, hardBlocked: false, retryAfterAt: null, lastError: null, lastSuccessAt: 'now', calls: 5 },
};

test('all lights green when every paid service is healthy', () => {
  const rows = buildPaidServicesStatus(healthyOverrides as any);
  assert.equal(rows.length, 3);
  for (const row of rows) { assert.equal(row.status, 'green'); assert.equal(row.reason, null); }
});

test('pumpportal red carries the provider error words', () => {
  const rows = buildPaidServicesStatus({
    ...healthyOverrides,
    pumpportal: {
      effectiveMode: 'lite', reason: 'pumpportal_rejected_or_errored',
      messages: { lastProtocolError: { errors: 'Invalid API key. PumpSwap data will not be streamed.' } },
    },
  } as any);
  const pp = rows.find(row => row.id === 'pumpportal')!;
  assert.equal(pp.status, 'red');
  assert.match(pp.reason!, /Invalid API key/);
});

test('helius red on stale success, gemini red carries recovery guidance when hard-blocked', () => {
  const rows = buildPaidServicesStatus({
    ...healthyOverrides,
    helius: { configured: true, lastSuccessAt: new Date(Date.now() - 60 * 60_000).toISOString(), lastFailureAt: null, lastError: null },
    gemini: { configured: true, hardBlocked: true, lastError: 'quota exhausted', recovery: 'restore AI Studio prepaid credits, then restart Railway' },
  } as any);
  assert.match(rows.find(row => row.id === 'helius')!.reason!, /No successful call in \d+ minutes/);
  const gem = rows.find(row => row.id === 'gemini')!;
  assert.equal(gem.status, 'red');
  assert.match(gem.reason!, /restore AI Studio prepaid credits/);
});

test('enhanced-only exhaustion stays GREEN with an informational note — RPC is unaffected', () => {
  // This is the exact bug found live 2026-07-30: bundle.ts and deployer.ts
  // (insider/bundle detection, the one proven edge) fail OPEN on a Helius
  // error. A shared budget meant an expensive-category leak silenced cheap RPC
  // for the rest of the day too, silently making every token look clean.
  const rows = buildPaidServicesStatus({
    pumpportal: { effectiveMode: 'full', messages: {} },
    helius: { configured: true, lastSuccessAt: new Date().toISOString() },
    heliusBudget: {
      estimatedCreditsUsed: 30000, dailyBudgetCredits: 30000, estimatedCreditsRemaining: 0,
      estimatedEnhancedCreditsUsed: 30000, estimatedRpcCreditsUsed: 8000,
      dailyRpcBudgetCredits: 50000, estimatedRpcCreditsRemaining: 42000,
      byCategory: { enhanced_address_history: 22000, enhanced_tx_parse: 8000, rpc: 8000 },
    },
    gemini: { configured: true, hardBlocked: false, lastSuccessAt: 'now' },
  } as any);
  const helius = rows.find(row => row.id === 'helius')!;
  assert.equal(helius.status, 'green', 'RPC still works — insider/bundle detection must not go dark');
  assert.match(helius.reason!, /Enhanced-API budget spent \(30000\/30000/);
  assert.match(helius.reason!, /RPC unaffected/);
  assert.match(String(helius.detail.topBurner), /enhanced_address_history/);
});

test('RPC exhaustion is genuinely red — that is the category insider detection depends on', () => {
  const rows = buildPaidServicesStatus({
    pumpportal: { effectiveMode: 'full', messages: {} },
    helius: { configured: true, lastSuccessAt: new Date().toISOString() },
    heliusBudget: {
      estimatedCreditsUsed: 80000, dailyBudgetCredits: 30000, estimatedCreditsRemaining: 0,
      estimatedEnhancedCreditsUsed: 30000, estimatedRpcCreditsUsed: 50000,
      dailyRpcBudgetCredits: 50000, estimatedRpcCreditsRemaining: 0,
      byCategory: { enhanced_address_history: 30000, rpc: 50000 },
    },
    gemini: { configured: true, hardBlocked: false, lastSuccessAt: 'now' },
  } as any);
  const helius = rows.find(row => row.id === 'helius')!;
  assert.equal(helius.status, 'red');
  assert.match(helius.reason!, /RPC credit budget spent \(50000\/50000/);
});

test('request classification prices enhanced history at 100 and rpc at 1', async () => {
  const { classifyHeliusRequest } = await import('../helius-free-budget');
  assert.deepEqual(classifyHeliusRequest('https://api.helius.xyz/v0/addresses/ABC/transactions?api-key=x'),
    { cost: 100, category: 'enhanced_address_history' });
  assert.deepEqual(classifyHeliusRequest('https://mainnet.helius-rpc.com/?api-key=x'),
    { cost: 1, category: 'rpc' });
});
