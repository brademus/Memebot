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

test('trade proof only expires long after going stale — a brief lull never trips it', async () => {
  const { shouldExpireTradeProof } = await import('./pumpfun');
  const now = Date.now();
  assert.equal(shouldExpireTradeProof(null, now), false, 'nothing to expire before any trade has ever arrived');
  assert.equal(shouldExpireTradeProof(now - 3 * 60_000, now), false, 'a 3-minute lull is not proof the feed died');
  assert.equal(shouldExpireTradeProof(now - 5 * 60_000, now), false, 'still short of double the mode-flip threshold');
  assert.equal(shouldExpireTradeProof(now - 9 * 60_000, now), true, 'well past double the threshold: treat proof as expired');
});

test('a feed that worked for hours then went silent must re-arm the from-boot self-heal check', async () => {
  // This is the exact bug found live 2026-07-30: lastTradeAt sticks at its last
  // real value forever, so createMessages>0 && lastTradeAt===null (the self-heal
  // trigger) could only ever fire once, for the from-boot case. Simulate the
  // timeline directly against the exported predicate.
  const { shouldExpireTradeProof } = await import('./pumpfun');
  const now = Date.now();
  const lastTradeAt = now - 3 * 60 * 60_000;   // worked hours ago, then silence
  const wouldSelfHealTriggerWithoutTheBridge = lastTradeAt === null;
  assert.equal(wouldSelfHealTriggerWithoutTheBridge, false, 'demonstrates the bug: a real past timestamp blocks the from-boot check forever');
  const expired = shouldExpireTradeProof(lastTradeAt, now);
  assert.equal(expired, true, 'the bridge must recognize this staleness');
  const lastTradeAtAfterBridge = expired ? null : lastTradeAt;
  assert.equal(lastTradeAtAfterBridge === null, true, 'once bridged, the from-boot check can engage again');
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
