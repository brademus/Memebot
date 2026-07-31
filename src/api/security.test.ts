import test from 'node:test';
import assert from 'node:assert/strict';
import { adminOnly } from './security';

function assertPasses(request: any) {
  let nextCalled = false;
  adminOnly(request, {} as any, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
}

function assertRejects(request: any, expectedStatus: number) {
  let nextCalled = false;
  let statusCode = 0;
  const response: any = {
    setHeader: () => {},
    status: (code: number) => { statusCode = code; return response; },
    json: () => response,
  };
  adminOnly(request, response, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(statusCode, expectedStatus);
}

test('read-only daily and BTC reports work without ADMIN_KEY', () => {
  const previous = process.env.ADMIN_KEY;
  delete process.env.ADMIN_KEY;
  assertPasses({
    method: 'POST',
    path: '/api/daily-review-jobs',
    originalUrl: '/api/daily-review-jobs?days=1',
    header: () => undefined,
  } as any);
  assertPasses({
    method: 'GET',
    path: '/api/daily-review-jobs/job-123',
    originalUrl: '/api/daily-review-jobs/job-123',
    header: () => undefined,
  } as any);
  assertPasses({
    method: 'POST',
    path: '/api/btc-review-jobs',
    originalUrl: '/api/btc-review-jobs?days=3650',
    header: () => undefined,
  } as any);
  assertPasses({
    method: 'GET',
    path: '/api/btc-review-jobs/job-123',
    originalUrl: '/api/btc-review-jobs/job-123',
    header: () => undefined,
  } as any);
  assertPasses({
    method: 'GET',
    path: '/api/btc-review-jobs/job-123/chunks/0',
    originalUrl: '/api/btc-review-jobs/job-123/chunks/0',
    header: () => undefined,
  } as any);
  if (previous === undefined) delete process.env.ADMIN_KEY;
  else process.env.ADMIN_KEY = previous;
});

test('mutation routes reject requests when ADMIN_KEY is not configured', () => {
  const previous = process.env.ADMIN_KEY;
  delete process.env.ADMIN_KEY;
  assertRejects({
    method: 'POST',
    path: '/api/wallets',
    originalUrl: '/api/wallets',
    header: () => undefined,
  } as any, 503);
  if (previous === undefined) delete process.env.ADMIN_KEY;
  else process.env.ADMIN_KEY = previous;
});

test('mutation routes reject wrong keys and accept the correct one', () => {
  const previous = process.env.ADMIN_KEY;
  process.env.ADMIN_KEY = 'correct-horse-battery-staple-private';
  const mutation = {
    method: 'POST',
    path: '/api/wallets',
    originalUrl: '/api/wallets',
  };
  assertRejects({ ...mutation, header: (name: string) => name === 'x-admin-key' ? 'wrong-key' : undefined } as any, 401);
  assertPasses({ ...mutation, header: (name: string) => name === 'x-admin-key' ? process.env.ADMIN_KEY : undefined } as any);
  if (previous === undefined) delete process.env.ADMIN_KEY;
  else process.env.ADMIN_KEY = previous;
});
