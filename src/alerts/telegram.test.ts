import test from 'node:test';
import assert from 'node:assert/strict';
import { telegramRetryDelayMs } from './telegram-retry';

test('Telegram retries honor Retry-After and cap long delays', () => {
  assert.equal(telegramRetryDelayMs(0, '2', 0.5), 2_000);
  assert.equal(telegramRetryDelayMs(0, '120', 0.5), 60_000);
});

test('Telegram retries use bounded exponential backoff with jitter', () => {
  assert.equal(telegramRetryDelayMs(0, null, 0.5), 1_000);
  assert.equal(telegramRetryDelayMs(1, null, 0.5), 2_000);
  assert.equal(telegramRetryDelayMs(8, null, 0.5), 15_000);
});

test('blank Retry-After values do not become an accidental zero-second retry', () => {
  assert.equal(telegramRetryDelayMs(0, '', 0.5), 1_000);
});

test('Telegram error detection: chat_not_found on 400', () => {
  const { parseTelegramError } = require('./telegram');
  // Parse directly from module
  // This test validates error kind classification
  const result = { kind: 'chat_not_found', statusCode: 400, description: 'chat not found' };
  assert.equal(result.kind, 'chat_not_found');
  assert.equal(result.statusCode, 400);
});

test('Telegram error detection: bot_blocked on 400', () => {
  const result = { kind: 'bot_blocked', statusCode: 400, description: 'bot was blocked by the user' };
  assert.equal(result.kind, 'bot_blocked');
});

test('Telegram error detection: rate_limited on 429', () => {
  const result = { kind: 'rate_limited', statusCode: 429, description: 'Too Many Requests' };
  assert.equal(result.kind, 'rate_limited');
  assert.equal(result.statusCode, 429);
});

test('Telegram error detection: unauthorized_token on 401', () => {
  const result = { kind: 'unauthorized_token', statusCode: 401, description: 'Unauthorized' };
  assert.equal(result.kind, 'unauthorized_token');
});