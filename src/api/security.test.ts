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

// These two tests previously asserted the mid-week 'auth disabled' behavior —
// including that a WRONG key passes. The final state restored strict private
// authentication; the tests now enshrine it so a future regression to open
// admin routes fails CI instead of being certified by it.
test('admin middleware rejects requests when ADMIN_KEY is not configured (503)', () => {
  const previous = process.env.ADMIN_KEY;
  delete process.env.ADMIN_KEY;
  assertRejects({ header: () => undefined } as any, 503);
  if (previous === undefined) delete process.env.ADMIN_KEY;
  else process.env.ADMIN_KEY = previous;
});

test('admin middleware rejects wrong keys and accepts the correct one', () => {
  const previous = process.env.ADMIN_KEY;
  process.env.ADMIN_KEY = 'correct-horse-battery-staple-private';
  assertRejects({ header: (name: string) => name === 'x-admin-key' ? 'wrong-key' : undefined } as any, 401);
  assertPasses({ header: (name: string) => name === 'x-admin-key' ? process.env.ADMIN_KEY : undefined } as any);
  if (previous === undefined) delete process.env.ADMIN_KEY;
  else process.env.ADMIN_KEY = previous;
});
