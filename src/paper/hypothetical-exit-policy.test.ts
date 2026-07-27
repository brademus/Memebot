import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HYPOTHETICAL_STAKE_USD,
  STOP_LOSS_MULTIPLE,
  TAKE_PROFIT_MULTIPLE,
  hypotheticalExitDecision,
} from './hypothetical-exit-policy';

test('closes a hypothetical $100 position at exactly 3x', () => {
  const result = hypotheticalExitDecision(2, 6.4);
  assert.deepEqual(result, {
    reason: 'take_profit_3x',
    exitPrice: 6,
    multiple: TAKE_PROFIT_MULTIPLE,
    proceedsUsd: 300,
    pnlUsd: 200,
  });
  assert.equal(HYPOTHETICAL_STAKE_USD, 100);
});

test('closes a hypothetical $100 position at a 50% loss', () => {
  const result = hypotheticalExitDecision(2, 0.9);
  assert.deepEqual(result, {
    reason: 'stop_loss_50pct',
    exitPrice: 1,
    multiple: STOP_LOSS_MULTIPLE,
    proceedsUsd: 50,
    pnlUsd: -50,
  });
});

test('keeps the position open between stop and target', () => {
  assert.equal(hypotheticalExitDecision(2, 3), null);
});

test('rejects invalid prices', () => {
  assert.equal(hypotheticalExitDecision(0, 3), null);
  assert.equal(hypotheticalExitDecision(2, Number.NaN), null);
});
