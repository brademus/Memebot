import test from 'node:test';
import assert from 'node:assert/strict';
import { assessEvidenceHealth } from './persistence-health';

test('evidence health is idle before any qualifying model decisions', () => {
  const health = assessEvidenceHealth({
    preliminaryTokens: 0, allowedTokens: 0, rawRows: 0, executableRows: 0,
    rawMissingTokens: 0, executableMissingTokens: 0,
  });
  assert.equal(health.status, 'idle');
  assert.equal(health.healthy, true);
});

test('evidence health detects missing raw and executable rows independently', () => {
  const health = assessEvidenceHealth({
    preliminaryTokens: 4, allowedTokens: 2, rawRows: 3, executableRows: 0,
    rawMissingTokens: 1, executableMissingTokens: 2,
  });
  assert.equal(health.status, 'degraded');
  assert.deepEqual(health.problems, ['model_raw_missing:1', 'model_executable_missing:2']);
});

test('evidence health is healthy when every mature decision has matching evidence', () => {
  const health = assessEvidenceHealth({
    preliminaryTokens: 7, allowedTokens: 3, rawRows: 7, executableRows: 3,
    rawMissingTokens: 0, executableMissingTokens: 0,
  });
  assert.equal(health.status, 'healthy');
  assert.equal(health.healthy, true);
});
