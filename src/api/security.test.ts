import test from 'node:test';
import assert from 'node:assert/strict';
import { adminOnly } from './security';

function assertPasses(request: any) {
  let nextCalled = false;
  adminOnly(request, {} as any, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
}

test('admin middleware allows requests when ADMIN_KEY is not configured', () => {
  const previous = process.env.ADMIN_KEY;
  delete process.env.ADMIN_KEY;
  assertPasses({ header: () => undefined } as any);
  if (previous === undefined) delete process.env.ADMIN_KEY;
  else process.env.ADMIN_KEY = previous;
});

test('admin middleware ignores supplied keys while private authentication is disabled', () => {
  const previous = process.env.ADMIN_KEY;
  process.env.ADMIN_KEY = 'correct-horse-battery-staple-private';
  assertPasses({ header: (name: string) => name === 'x-admin-key' ? 'wrong-key' : undefined } as any);
  assertPasses({ header: (name: string) => name === 'x-admin-key' ? process.env.ADMIN_KEY : undefined } as any);
  if (previous === undefined) delete process.env.ADMIN_KEY;
  else process.env.ADMIN_KEY = previous;
});
