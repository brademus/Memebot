import test from 'node:test';
import assert from 'node:assert/strict';
import { runSection } from './report';

test('a section honors its caller-provided timeout instead of the 18s default', async () => {
  const slow = () => new Promise(resolve => setTimeout(() => resolve({ ok: true }), 60));
  const tight = await runSection('tight', slow, 20);
  assert.equal(tight.timedOut, true, 'a 60ms build must time out under a 20ms ceiling');
  assert.match(String(tight.value.error), /exceeded 20ms/);
  const patient = await runSection('patient', slow, 500);
  assert.equal(patient.timedOut, false, 'the same build succeeds under a patient ceiling');
  assert.deepEqual(patient.value, { ok: true });
});

test('a section failure degrades to an explicit error field, never a throw', async () => {
  const broken = () => Promise.reject(new Error('database exploded'));
  const result = await runSection('broken', broken, 1_000);
  assert.equal(result.timedOut, false);
  assert.match(String(result.value.error), /database exploded/);
});
