import test from 'node:test';
import assert from 'node:assert/strict';
import { isGeminiHardQuota } from './gemini';

test('classifies billing exhaustion as a hard Gemini quota failure', () => {
  assert.equal(isGeminiHardQuota(429, 'Your prepayment credits are depleted.'), true);
  assert.equal(isGeminiHardQuota(429, 'Rate limit exceeded. Retry later.'), false);
  assert.equal(isGeminiHardQuota(403, 'API key rejected'), true);
  assert.equal(isGeminiHardQuota(500, 'billing account'), false);
});
