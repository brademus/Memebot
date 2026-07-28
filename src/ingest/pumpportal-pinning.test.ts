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
