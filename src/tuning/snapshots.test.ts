import test from 'node:test';
import assert from 'node:assert/strict';
import { snapshotAgeDue } from './snapshots';

test('captures only inside exact configured score windows', () => {
  assert.equal(snapshotAgeDue(2.99), null);
  assert.equal(snapshotAgeDue(3.01), 3);
  assert.equal(snapshotAgeDue(3.74), 3);
  assert.equal(snapshotAgeDue(3.76), null);
  assert.equal(snapshotAgeDue(5.2), 5);
  assert.equal(snapshotAgeDue(10.5), 10);
  assert.equal(snapshotAgeDue(15.7), 15);
  assert.equal(snapshotAgeDue(16), null);
});
