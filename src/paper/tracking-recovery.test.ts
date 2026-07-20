import test from 'node:test';
import assert from 'node:assert/strict';
import {
  __resetTrackingRecoveryForTest,
  recoverPaperMark,
  shouldDeclareTrackingLost,
  trackingRecoveryDiag,
} from './tracking-recovery';

test('tracking loss requires a sustained missing-price grace period', () => {
  const now = Date.UTC(2026, 6, 20, 12, 0, 0);
  assert.equal(shouldDeclareTrackingLost(new Date(now - 60_000), now, 120_000), false);
  assert.equal(shouldDeclareTrackingLost(new Date(now - 120_000), now, 120_000), true);
  assert.equal(shouldDeclareTrackingLost(null, now, 120_000), false);
  assert.equal(shouldDeclareTrackingLost('not-a-date', now, 120_000), false);
});

test('Dexscreener recovery caches a valid fallback mark', { concurrency: false }, async () => {
  __resetTrackingRecoveryForTest();
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches++;
    return new Response(JSON.stringify({
      pairs: [{
        chainId: 'solana',
        liquidity: { usd: 50_000 },
        priceUsd: '0.00042',
        fdv: 420_000,
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  try {
    const first = await recoverPaperMark('mint-address');
    const second = await recoverPaperMark('mint-address');
    assert.equal(first?.price, 0.00042);
    assert.equal(first?.source, 'dexscreener_recovery');
    assert.deepEqual(second, first);
    assert.equal(fetches, 1);
    assert.equal(trackingRecoveryDiag().cacheHits, 1);
  } finally {
    globalThis.fetch = originalFetch;
    __resetTrackingRecoveryForTest();
  }
});

test('concurrent recovery requests share one network request', { concurrency: false }, async () => {
  __resetTrackingRecoveryForTest();
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches++;
    await new Promise(resolve => setTimeout(resolve, 20));
    return new Response(JSON.stringify({ pairs: [{ priceUsd: '1', liquidity: { usd: 1 }, fdv: 2 }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const [left, right] = await Promise.all([
      recoverPaperMark('shared-mint'),
      recoverPaperMark('shared-mint'),
    ]);
    assert.equal(left?.price, 1);
    assert.equal(right?.price, 1);
    assert.equal(fetches, 1);
    assert.equal(trackingRecoveryDiag().deduped, 1);
  } finally {
    globalThis.fetch = originalFetch;
    __resetTrackingRecoveryForTest();
  }
});
