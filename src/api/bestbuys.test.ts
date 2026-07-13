import test from 'node:test';
import assert from 'node:assert/strict';
import { isSecondWaveRetrace } from './bestbuys';

test('accepts only the configured 25-40 percent second-wave retrace', () => {
  assert.equal(isSecondWaveRetrace(75, 100, 0.25, 0.40), true);
  assert.equal(isSecondWaveRetrace(60, 100, 0.25, 0.40), true);
  assert.equal(isSecondWaveRetrace(76, 100, 0.25, 0.40), false);
  assert.equal(isSecondWaveRetrace(59, 100, 0.25, 0.40), false);
});

test('rejects missing or invalid peak data', () => {
  assert.equal(isSecondWaveRetrace(0, 100, 0.25, 0.40), false);
  assert.equal(isSecondWaveRetrace(75, 0, 0.25, 0.40), false);
});
