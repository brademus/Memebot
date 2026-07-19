import test from 'node:test';
import assert from 'node:assert/strict';
import { adminOnly } from './security';

test('admin middleware allows mutating requests without a key', () => {
  let nextCalled = false;
  const request = { method: 'POST', headers: {} } as any;
  const response = {
    status() { throw new Error('admin middleware should not reject the request'); },
  } as any;

  adminOnly(request, response, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});

test('admin middleware also allows diagnostic reads without a key', () => {
  let nextCalled = false;
  adminOnly({ method: 'GET', headers: {} } as any, {} as any, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});
