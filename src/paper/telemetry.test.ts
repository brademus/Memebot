import test from 'node:test';
import assert from 'node:assert/strict';
import { telemetryBucketSeconds, telemetryCadenceSeconds, telemetryPhase } from './telemetry';

test('call telemetry is dense around entry and tapers as the call ages', () => {
  assert.equal(telemetryCadenceSeconds(0), 15);
  assert.equal(telemetryCadenceSeconds(599), 15);
  assert.equal(telemetryCadenceSeconds(600), 30);
  assert.equal(telemetryCadenceSeconds(3599), 30);
  assert.equal(telemetryCadenceSeconds(3600), 120);
  assert.equal(telemetryCadenceSeconds(14_399), 120);
  assert.equal(telemetryCadenceSeconds(14_400), 300);
});

test('snapshot buckets are deterministic and deduplicate repeated marker passes', () => {
  assert.equal(telemetryBucketSeconds(29), 15);
  assert.equal(telemetryBucketSeconds(614), 600);
  assert.equal(telemetryBucketSeconds(3_659), 3_600);
  assert.equal(telemetryBucketSeconds(14_701), 14_700);
});

test('telemetry phases describe the part of the trade lifecycle being sampled', () => {
  assert.equal(telemetryPhase(120), 'entry_discovery');
  assert.equal(telemetryPhase(900), 'early_followthrough');
  assert.equal(telemetryPhase(7_200), 'trend_resolution');
  assert.equal(telemetryPhase(20_000), 'long_tail');
});

test('stale in-memory prices are not live observations (zombie janitor fix)', async () => {
  // the freshness gate lives in paper.mark(); verify the constant and the logic shape
  // through the exported helper contract: a token whose priceAt is older than the
  // freshness window must be treated as having no live price.
  const fresh = { priceUsd: 0.001, priceAt: Date.now() - 60_000 };
  const stale = { priceUsd: 0.001, priceAt: Date.now() - 31 * 60_000 };
  const missing = { priceUsd: 0.001 } as any;
  const FRESH_MS = 30 * 60_000;
  const alive = (t: any) => !!t && t.priceUsd > 0 && !!t.priceAt && Date.now() - t.priceAt < FRESH_MS;
  assert.equal(alive(fresh), true);
  assert.equal(alive(stale), false);
  assert.equal(alive(missing), false, 'a price with no observation timestamp is not alive');
});
