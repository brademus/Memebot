import assert from 'node:assert';
import { test } from 'node:test';
import { classifyTelegramError } from './telegram';

test('Telegram classifier: generic 400 not misclassified as chat_not_found', () => {
  const error = classifyTelegramError(400, JSON.stringify({ error_code: 400, description: 'Bad Request' }));
  assert.strictEqual(error.kind, 'malformed_request', 'generic 400 should be malformed_request');
});

test('Telegram classifier: description-specific 400 cases', () => {
  const chatNotFound = classifyTelegramError(400, JSON.stringify({ description: 'chat not found' }));
  assert.strictEqual(chatNotFound.kind, 'chat_not_found');

  const blocked = classifyTelegramError(400, JSON.stringify({ description: 'bot was blocked by the user' }));
  assert.strictEqual(blocked.kind, 'bot_blocked');

  const tooLong = classifyTelegramError(400, JSON.stringify({ description: 'message text is empty' }));
  assert.strictEqual(tooLong.kind, 'message_too_long');
});

test('Telegram classifier: sanitizes URLs and tokens in description', () => {
  const error = classifyTelegramError(
    400,
    JSON.stringify({
      description: 'Error at https://api.telegram.org?api_key=sk_test_1234567890abcdef token=pk_live_abcd1234',
    }),
  );
  assert(!error.description?.includes('https://'), 'URLs should be redacted to [URL]');
  assert(!error.description?.includes('sk_test_'), 'tokens should be redacted');
  assert(!error.description?.includes('api_key='), 'api_key parameters should be redacted');
  assert(error.description?.includes('[URL]'), 'should contain [URL] placeholder');
  assert(error.description?.includes('[REDACTED]'), 'should contain [REDACTED] placeholder');
});

test('Telegram classifier: truncates long descriptions', () => {
  const longDesc = 'x'.repeat(300);
  const error = classifyTelegramError(400, JSON.stringify({ description: longDesc }));
  assert(error.description!.length <= 200, 'description should be truncated to 200 chars');
});

