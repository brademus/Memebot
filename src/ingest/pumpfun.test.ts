import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyPumpPortalMessage,
  pumpPortalRejection,
  redactPumpPortalText,
  tradeStreamModeFromHealth,
} from './pumpfun';

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

test('classifies PumpPortal event and control payloads', () => {
  assert.equal(classifyPumpPortalMessage({ mint: 'mint', txType: 'create' }), 'create');
  assert.equal(classifyPumpPortalMessage({ mint: 'mint', txType: 'buy' }), 'trade');
  assert.equal(classifyPumpPortalMessage({ mint: 'mint', txType: 'sell' }), 'trade');
  assert.equal(classifyPumpPortalMessage({ mint: 'mint', txType: 'migration' }), 'migration');
  assert.equal(classifyPumpPortalMessage({ message: 'Successfully subscribed' }), 'control');
  assert.equal(classifyPumpPortalMessage({ error: 'Invalid API key' }), 'control');
  assert.equal(classifyPumpPortalMessage({ unexpected: true }), 'unknown');
  assert.equal(classifyPumpPortalMessage('plain text'), 'unknown');
});

test('recognizes rejection payloads without treating normal acknowledgements as failures', () => {
  assert.equal(pumpPortalRejection({ message: 'Successfully subscribed' }), null);
  assert.match(pumpPortalRejection({ error: 'Invalid API key' }) || '', /Invalid API key/);
  assert.match(pumpPortalRejection({ success: false, message: 'Insufficient balance' }) || '', /Insufficient balance/);
  assert.match(pumpPortalRejection({ status: 'rejected', message: 'Too many connections' }) || '', /Too many connections/);
});

test('redacts the API key from diagnostic payloads and websocket URLs', () => {
  const secret = 'pump-secret-key';
  const text = redactPumpPortalText({
    error: `invalid api-key=${secret}`,
    url: `wss://pumpportal.fun/api/data?api-key=${secret}&x=1`,
  }, secret);
  assert.equal(text.includes(secret), false);
  assert.match(text, /REDACTED_API_KEY/);
});
