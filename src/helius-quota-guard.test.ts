import test from 'node:test';
import assert from 'node:assert/strict';
import { isHeliusHardQuotaMessage, shouldAttemptHeliusProbe } from './helius-quota-guard';

test('Helius hard quota errors are distinguished from ordinary rate limits', () => {
  assert.equal(isHeliusHardQuotaMessage(429, '{"error":"max usage reached"}'), true);
  assert.equal(isHeliusHardQuotaMessage(429, '{"error":"RATE_LIMIT_EXCEEDED"}'), false);
  assert.equal(isHeliusHardQuotaMessage(503, 'max usage reached'), false);
});

test('Helius blocked circuit permits only a cooldown-based recovery probe', () => {
  const now = 1_000_000;
  const cooldown = 900_000;
  assert.equal(shouldAttemptHeliusProbe(false, null, now, cooldown), false);
  assert.equal(shouldAttemptHeliusProbe(true, null, now, cooldown), true);
  assert.equal(shouldAttemptHeliusProbe(true, now - cooldown + 1, now, cooldown), false);
  assert.equal(shouldAttemptHeliusProbe(true, now - cooldown, now, cooldown), true);
});
