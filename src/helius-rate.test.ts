import test from 'node:test';
import assert from 'node:assert/strict';
import {
  __resetHeliusForTest,
  heliusBackoffMs,
  heliusHealth,
  heliusRequest,
  isRetryableHeliusStatus,
  parseRetryAfterMs,
} from './helius';

test('classifies retryable Helius failures and parses Retry-After', () => {
  assert.equal(isRetryableHeliusStatus(429), true);
  assert.equal(isRetryableHeliusStatus(503), true);
  assert.equal(isRetryableHeliusStatus(401), false);
  assert.equal(parseRetryAfterMs('2', 0), 2000);
  assert.equal(parseRetryAfterMs('not-a-date', 0), null);
  assert.equal(heliusBackoffMs(0, null, '', 0.5), 1000);
  assert.equal(heliusBackoffMs(8, null, '', 0.5), 30_000);
  assert.equal(heliusBackoffMs(0, null, 'max usage reached', 0.5), 5 * 60_000);
});

test('a max-usage 429 opens the circuit and sheds new background work', { concurrency: false }, async () => {
  __resetHeliusForTest();
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches++;
    return new Response(JSON.stringify({ error: 'max usage reached' }), {
      status: 429,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const first = await heliusRequest('https://example.test/one', {}, {
      group: 'enhanced', priority: 'bg', maxAttempts: 1, dedupeKey: 'circuit:first',
    });
    assert.equal(first.status, 429);

    const second = await heliusRequest('https://example.test/two', {}, {
      group: 'enhanced', priority: 'bg', maxAttempts: 1, dedupeKey: 'circuit:second',
    });
    assert.equal(second.skipped, true);
    assert.equal(second.error, 'helius_background_request_deferred');
    assert.equal(fetches, 1);

    const health = heliusHealth();
    assert.equal(health.got429, 1);
    assert.equal(health.droppedBackground, 1);
    assert.equal((health.groups as any).enhanced.blocked, true);
  } finally {
    globalThis.fetch = originalFetch;
    __resetHeliusForTest();
  }
});

test('identical concurrent requests share one Helius network call', { concurrency: false }, async () => {
  __resetHeliusForTest();
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches++;
    await new Promise(resolve => setTimeout(resolve, 20));
    return new Response(JSON.stringify([{ signature: 'abc' }]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const [left, right] = await Promise.all([
      heliusRequest<any[]>('https://example.test/shared', {}, {
        group: 'enhanced', priority: 'fg', dedupeKey: 'shared-request',
      }),
      heliusRequest<any[]>('https://example.test/shared', {}, {
        group: 'enhanced', priority: 'fg', dedupeKey: 'shared-request',
      }),
    ]);
    assert.equal(left.ok, true);
    assert.deepEqual(right.data, [{ signature: 'abc' }]);
    assert.equal(fetches, 1);
    assert.equal(heliusHealth().dedupedCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    __resetHeliusForTest();
  }
});

test('successful cached requests avoid repeated credit usage', { concurrency: false }, async () => {
  __resetHeliusForTest();
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches++;
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const options = {
      group: 'enhanced' as const,
      priority: 'fg' as const,
      dedupeKey: 'cached-request',
      cacheTtlMs: 60_000,
    };
    const first = await heliusRequest('https://example.test/cache', {}, options);
    const second = await heliusRequest('https://example.test/cache', {}, options);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(fetches, 1);
    assert.equal(heliusHealth().cacheHits, 1);
  } finally {
    globalThis.fetch = originalFetch;
    __resetHeliusForTest();
  }
});
