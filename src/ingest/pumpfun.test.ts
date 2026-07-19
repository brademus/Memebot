import test from 'node:test';
import assert from 'node:assert/strict';
import { tradeStreamModeFromHealth } from './pumpfun';

const now = 1_000_000;
const staleMs = 240_000;

test('uses aggregate mode when the token-trade feed is not configured', () => {
  assert.equal(tradeStreamModeFromHealth(false, now, now, staleMs), 'lite');
});

test('uses aggregate mode until a configured feed actually emits a trade', () => {
  assert.equal(tradeStreamModeFromHealth(true, null, now, staleMs), 'lite');
});

test('uses strict wallet evidence while trade events are fresh', () => {
  assert.equal(tradeStreamModeFromHealth(true, now - 30_000, now, staleMs), 'full');
});

test('falls back to aggregate evidence when the configured feed becomes stale', () => {
  assert.equal(tradeStreamModeFromHealth(true, now - staleMs - 1, now, staleMs), 'lite');
});
