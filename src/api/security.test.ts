import test from 'node:test';
import assert from 'node:assert/strict';
import { adminOnly } from './security';

function responseRecorder() {
  const output: any = { statusCode: null, body: null, headers: {} };
  const response = {
    setHeader(name: string, value: string) { output.headers[name] = value; },
    status(code: number) { output.statusCode = code; return response; },
    json(body: unknown) { output.body = body; return response; },
  } as any;
  return { response, output };
}

test('admin middleware fails closed when ADMIN_KEY is not configured', () => {
  const previous = process.env.ADMIN_KEY;
  delete process.env.ADMIN_KEY;
  const { response, output } = responseRecorder();
  let nextCalled = false;
  adminOnly({ header: () => undefined } as any, response, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(output.statusCode, 503);
  process.env.ADMIN_KEY = previous;
});

test('admin middleware accepts the dashboard x-admin-key header', () => {
  const previous = process.env.ADMIN_KEY;
  process.env.ADMIN_KEY = 'correct-horse-battery-staple-private';
  const { response, output } = responseRecorder();
  let nextCalled = false;
  adminOnly({ header: (name: string) => name === 'x-admin-key' ? process.env.ADMIN_KEY : undefined } as any,
    response, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(output.statusCode, null);
  process.env.ADMIN_KEY = previous;
});

test('admin middleware rejects an invalid key', () => {
  const previous = process.env.ADMIN_KEY;
  process.env.ADMIN_KEY = 'correct-horse-battery-staple-private';
  const { response, output } = responseRecorder();
  let nextCalled = false;
  adminOnly({ header: (name: string) => name === 'x-admin-key' ? 'wrong-key' : undefined } as any,
    response, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(output.statusCode, 401);
  process.env.ADMIN_KEY = previous;
});
