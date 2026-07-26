import assert from 'node:assert';
import { test } from 'node:test';
import { jupiterCanaryDiag } from './jupiter-canary';

test('Jupiter canary diagnostics', async () => {
  const diag = jupiterCanaryDiag();

  assert(typeof diag.configured === 'boolean', 'configured should be boolean');
  assert(typeof diag.executed === 'boolean', 'executed should be boolean');
  assert(diag.lastAttemptAt === null || typeof diag.lastAttemptAt === 'string', 'lastAttemptAt should be null or string');
  assert(diag.lastResult === null || typeof diag.lastResult === 'object', 'lastResult should be null or object');
  assert(typeof diag.supportsUnsignedSimulation === 'boolean', 'supportsUnsignedSimulation should be boolean');

  // Safety invariants: no sign/send/broadcast methods exposed
  assert(!('sign' in (diag.lastResult || {})), 'canary result must not expose sign method');
  assert(!('broadcast' in (diag.lastResult || {})), 'canary result must not expose broadcast method');
  assert(!('send' in (diag.lastResult || {})), 'canary result must not expose send method');
});

test('Jupiter canary wallet redaction', async () => {
  const diag = jupiterCanaryDiag();
  if (diag.lastResult?.wallet) {
    const wallet = diag.lastResult.wallet;
    // Wallet should be redacted to form: "XXXX…XXXX"
    assert(wallet.includes('…'), 'wallet should be redacted with ellipsis');
    assert(wallet.length < 20, 'redacted wallet should be short');
  }
});

