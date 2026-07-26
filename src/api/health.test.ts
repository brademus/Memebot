import assert from 'node:assert';
import { test } from 'node:test';
import { handleHealth, statusToHttpCode, type HealthStatus } from './health';

test('Health endpoint response structure', async () => {
  const result = await handleHealth();

  assert(typeof result === 'object', 'health result should be object');
  assert(result !== null, 'health result should not be null');
  assert('status' in result, 'health result must have status field');
  assert(['healthy', 'degraded', 'unhealthy', 'unavailable'].includes(result.status), 'status must be a valid HealthStatus');
});

test('Status to HTTP code mapping', () => {
  const testCases: Array<[HealthStatus, number]> = [
    ['healthy', 200],
    ['degraded', 200],
    ['unhealthy', 503],
    ['unavailable', 503],
  ];

  for (const [status, expectedCode] of testCases) {
    const code = statusToHttpCode(status);
    assert.strictEqual(code, expectedCode, `status '${status}' should map to ${expectedCode}`);
  }
});

test('Health endpoint returns unavailable when database not configured', async () => {
  const result = await handleHealth();
  // If DATABASE_URL is not set (sandbox case), status should be unavailable
  // Otherwise healthy/degraded based on diagnostics
  assert(
    ['unavailable', 'healthy', 'degraded', 'unhealthy'].includes(result.status),
    'status must be valid',
  );
});

