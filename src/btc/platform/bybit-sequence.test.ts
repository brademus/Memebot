import assert from 'node:assert/strict';
import test from 'node:test';
import { assessOrderbookSequence } from './bybit-sequence';

test('snapshot establishes or replaces the local order-book sequence', () => {
  assert.deepEqual(assessOrderbookSequence(null, 'snapshot', 8_000), {
    current: 8_000, accept: true, reset: true, gap: false,
  });
  assert.deepEqual(assessOrderbookSequence(9_000, 'delta', 1), {
    current: 1, accept: true, reset: true, gap: false,
  });
});

test('contiguous order-book deltas are accepted', () => {
  assert.deepEqual(assessOrderbookSequence(8_000, 'delta', 8_001), {
    current: 8_001, accept: true, reset: false, gap: false,
  });
});

test('duplicates and stale deltas are ignored without creating a false gap', () => {
  assert.deepEqual(assessOrderbookSequence(8_001, 'delta', 8_001), {
    current: 8_001, accept: false, reset: false, gap: false,
  });
  assert.deepEqual(assessOrderbookSequence(8_001, 'delta', 8_000), {
    current: 8_001, accept: false, reset: false, gap: false,
  });
});

test('a real order-book update-id jump requests resynchronization', () => {
  assert.deepEqual(assessOrderbookSequence(8_001, 'delta', 8_004), {
    current: null, accept: false, reset: false, gap: true,
  });
});

test('a delta before the initial snapshot is rejected as unsafe', () => {
  assert.deepEqual(assessOrderbookSequence(null, 'delta', 8_001), {
    current: null, accept: false, reset: false, gap: true,
  });
});
