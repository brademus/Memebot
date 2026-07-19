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
