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
