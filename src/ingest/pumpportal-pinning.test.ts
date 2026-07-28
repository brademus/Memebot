import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { setPinnedKeysProvider, __guardInternalsForTest as guard } from './pumpportal-guard';

// sendRaw .call()s the captured real WebSocket.prototype.send on the socket, so the
// fake must carry the ws internals that method touches.
const fakeSocket = {
  readyState: WebSocket.OPEN,
  _extensions: {},
  _sender: { send: (_data: unknown, _options: unknown, callback?: () => void) => { callback?.(); } },
} as unknown as WebSocket;

test('pinned open positions are never rotated out and take first claim on free slots', () => {
  const { state } = guard;
  state.active.clear(); state.pendingKeys.clear(); state.urgentKeys.clear();
  const now = Date.now();
  const stale = now - 10 * 60_000;   // far past any quiet-slot lease
  setPinnedKeysProvider(() => ['PINNED_OPEN_POSITION', 'PINNED_WAITING']);

  // Rotation: both slots quiet past lease; only the unpinned one may be evicted.
  state.active.set('PINNED_OPEN_POSITION', { subscribedAt: stale, lastEventAt: null });
  state.active.set('UNPINNED_QUIET', { subscribedAt: stale - 1, lastEventAt: null });
  state.urgentKeys.set('NEWCOMER', now);
  state.lastRotationAt = 0;
  // fill remaining capacity so rotation logic engages
  for (let index = 0; state.active.size < 40; index++) {
    state.active.set(`FILLER_${index}`, { subscribedAt: now, lastEventAt: now });
  }
  guard.rotateOneQuietSlot(fakeSocket, now);
  assert.equal(state.active.has('PINNED_OPEN_POSITION'), true, 'pinned slot must survive rotation');
  assert.equal(state.active.has('UNPINNED_QUIET'), false, 'unpinned quiet slot is the one evicted');

  // Pending priority: the pinned pending key outranks older urgent keys.
  state.pendingKeys.set('SOME_RESEARCH', now);
  state.pendingKeys.set('PINNED_WAITING', now);
  const selected = guard.nextPending(1);
  assert.deepEqual(selected, ['PINNED_WAITING']);

  setPinnedKeysProvider(() => []);
  state.active.clear(); state.pendingKeys.clear(); state.urgentKeys.clear();
});

test('pin reconciliation enqueues a missing open position at highest priority', () => {
  const { state } = guard;
  state.active.clear(); state.pendingKeys.clear(); state.urgentKeys.clear();
  setPinnedKeysProvider(() => ['MISSING_OPEN_POSITION']);
  guard.reconcilePins();
  assert.equal(state.pendingKeys.has('MISSING_OPEN_POSITION'), true);
  assert.equal(state.urgentKeys.has('MISSING_OPEN_POSITION'), true);
  setPinnedKeysProvider(() => []);
  state.pendingKeys.clear(); state.urgentKeys.clear();
});

test('pending-queue trimming never evicts pinned keys', () => {
  const { state } = guard;
  state.active.clear(); state.pendingKeys.clear(); state.urgentKeys.clear();
  setPinnedKeysProvider(() => ['PINNED_KEEP']);
  const now = Date.now();
  state.pendingKeys.set('PINNED_KEEP', now - 1_000_000);   // oldest of all
  for (let index = 0; index < guard.MAX_PENDING_TOKENS + 5; index++) {
    state.pendingKeys.set(`BULK_${index}`, now + index);
  }
  guard.trimPending();
  assert.equal(state.pendingKeys.has('PINNED_KEEP'), true, 'oldest pinned key must survive trimming');
  assert.ok(state.pendingKeys.size <= guard.MAX_PENDING_TOKENS);
  setPinnedKeysProvider(() => []);
  state.pendingKeys.clear();
});

test('a pinned pending key forces quiet-slot rotation even with no urgent keys', () => {
  const { state } = guard;
  state.active.clear(); state.pendingKeys.clear(); state.urgentKeys.clear();
  const now = Date.now();
  const stale = now - 10 * 60_000;
  setPinnedKeysProvider(() => ['PINNED_NEEDS_SLOT']);
  state.pendingKeys.set('PINNED_NEEDS_SLOT', now);
  state.active.set('UNPINNED_QUIET_2', { subscribedAt: stale, lastEventAt: null });
  for (let index = 0; state.active.size < 40; index++) {
    state.active.set(`FILL2_${index}`, { subscribedAt: now, lastEventAt: now });
  }
  state.lastRotationAt = 0;
  guard.rotateOneQuietSlot(fakeSocket, now);
  assert.equal(state.active.has('UNPINNED_QUIET_2'), false, 'quiet slot must rotate out for the pinned pending position');
  setPinnedKeysProvider(() => []);
  state.active.clear(); state.pendingKeys.clear();
});

test('only lively positions deserve pins: fresh price or young entry', async () => {
  const { pinWorthy } = await import('../paper/open-positions-cache');
  const now = Date.now();
  assert.equal(pinWorthy(now - 5 * 60_000, null, now), true, 'young entry earns its chance');
  assert.equal(pinWorthy(now - 60 * 60_000, now - 2 * 60_000, now), true, 'fresh price keeps the pin');
  assert.equal(pinWorthy(now - 60 * 60_000, now - 45 * 60_000, now), false, 'stale price loses the pin');
  assert.equal(pinWorthy(now - 60 * 60_000, null, now), false, 'no observation, no pin');
});
