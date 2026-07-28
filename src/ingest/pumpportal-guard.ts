import WebSocket from 'ws';
import { openPositionsCacheDiag } from '../paper/open-positions-cache';
import {
  consumePersistentPaidEvent,
  ensurePumpPortalPersistentBudget,
  onPumpPortalBudgetAvailable,
  paidStreamBudgetAvailable,
  pumpPortalPersistentBudgetDiag,
} from './pumpportal-persistent-budget';

// PumpPortal recommends one websocket with additive subscriptions. This guard is the sole
// owner of the provider-side paid subscription set. Scanner lifecycle removals are ignored:
// a token leaving the dashboard must not silently tear down a paid stream that is still
// collecting evidence. The persistent PostgreSQL budget remains the spending ceiling.
const MAX_ACTIVE_TOKENS = Math.max(1, Math.min(100, Number(process.env.PUMPPORTAL_MAX_ACTIVE_TOKENS || 40)));
const MAX_PENDING_TOKENS = Math.max(40, Math.min(250, Number(process.env.PUMPPORTAL_MAX_PENDING_TOKENS || 250)));
const PROVIDER_RETRY_MS = Math.max(60_000, Math.min(30 * 60_000, Number(process.env.PUMPPORTAL_PROVIDER_RETRY_MS || 5 * 60_000)));
const QUIET_SLOT_LEASE_MS = Math.max(30_000, Math.min(60 * 60_000, Number(process.env.PUMPPORTAL_QUIET_SLOT_LEASE_MS || 2 * 60_000)));
const ROTATION_INTERVAL_MS = Math.max(10_000, Math.min(5 * 60_000, Number(process.env.PUMPPORTAL_ROTATION_INTERVAL_MS || 30_000)));
const ENTITLEMENT_WARNING_MS = Math.max(60_000, Math.min(15 * 60_000, Number(process.env.PUMPPORTAL_ENTITLEMENT_WARNING_MS || 2 * 60_000)));
const MAINTENANCE_INTERVAL_MS = 15_000;

interface ActiveSubscription {
  subscribedAt: number;
  lastEventAt: number | null;
}

interface PumpPortalGuardState {
  active: Map<string, ActiveSubscription>;
  pendingKeys: Map<string, number>;
  urgentKeys: Map<string, number>;
  paidEvents: number;
  suppressedDuplicateKeys: number;
  suppressedOverBudgetKeys: number;
  evictedKeys: number;
  droppedPendingKeys: number;
  subscribeCommands: number;
  unsubscribeCommands: number;
  ignoredApplicationUnsubscribes: number;
  urgentRotations: number;
  rawSubscribedKeys: number;
  budgetTripped: boolean;
  providerRejected: boolean;
  providerRejections: number;
  providerRecoveryAttempts: number;
  startedAt: number;
  lastEventAt: number | null;
  firstPaidSubscriptionAt: number | null;
  lastBudgetTripAt: number | null;
  lastProviderRejection: string | null;
  providerRetryAt: number | null;
  lastSubscriptionAt: number | null;
  lastMaintenanceAt: number | null;
  lastRotationAt: number | null;
  socketGenerations: number;
}

const state: PumpPortalGuardState = {
  active: new Map(),
  pendingKeys: new Map(),
  urgentKeys: new Map(),
  paidEvents: 0,
  suppressedDuplicateKeys: 0,
  suppressedOverBudgetKeys: 0,
  evictedKeys: 0,
  droppedPendingKeys: 0,
  subscribeCommands: 0,
  unsubscribeCommands: 0,
  ignoredApplicationUnsubscribes: 0,
  urgentRotations: 0,
  rawSubscribedKeys: 0,
  budgetTripped: false,
  providerRejected: false,
  providerRejections: 0,
  providerRecoveryAttempts: 0,
  startedAt: Date.now(),
  lastEventAt: null,
  firstPaidSubscriptionAt: null,
  lastBudgetTripAt: null,
  lastProviderRejection: null,
  providerRetryAt: null,
  lastSubscriptionAt: null,
  lastMaintenanceAt: null,
  lastRotationAt: null,
  socketGenerations: 0,
};

const isPumpPortalSocket = (socket: any) => String(socket?.url || '').includes('pumpportal.fun/api/data');
const rawSend = WebSocket.prototype.send;
const rawEmit = WebSocket.prototype.emit;
let guardedSocket: WebSocket | null = null;

function parsePayload(value: unknown): any | null {
  try {
    if (typeof value === 'string') return JSON.parse(value);
    if (Buffer.isBuffer(value)) return JSON.parse(value.toString('utf8'));
    if (value instanceof ArrayBuffer) return JSON.parse(Buffer.from(value).toString('utf8'));
    if (ArrayBuffer.isView(value)) return JSON.parse(Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('utf8'));
  } catch {}
  return null;
}

function sendRaw(socket: WebSocket, payload: unknown) {
  (rawSend as any).call(socket, JSON.stringify(payload));
}

function ensureSocket(socket: WebSocket) {
  if (socket === guardedSocket) return;
  guardedSocket = socket;
  // A replacement websocket has no server-side subscriptions. Requeue the prior set and
  // restore it on this one socket after the application sends its free subscriptions.
  const now = Date.now();
  for (const key of state.active.keys()) state.pendingKeys.set(key, now);
  state.active.clear();
  state.socketGenerations++;
}

function trimPending() {
  const pinned = pinnedSet();
  let scanned = 0;
  while (state.pendingKeys.size > MAX_PENDING_TOKENS) {
    if (scanned++ > MAX_PENDING_TOKENS + 64) break;   // everything pinned: never evict pins
    const oldest = [...state.pendingKeys.keys()].find(key => !pinned.has(key));
    if (!oldest) break;
    state.pendingKeys.delete(oldest);
    state.urgentKeys.delete(oldest);
    state.droppedPendingKeys++;
  }
}

let pinnedKeysProvider: () => string[] = () => [];
/** Wired at boot to the open-positions cache: pinned keys are open timed-entry
 *  positions. They are never rotated out of a paid slot and take first claim on
 *  free slots, so a live position keeps exact-event coverage until it closes. */
export function setPinnedKeysProvider(provider: () => string[]) { pinnedKeysProvider = provider; }
function pinnedSet(): Set<string> {
  try { return new Set(pinnedKeysProvider()); } catch { return new Set(); }
}

/** A pinned mint known to the cache but absent from both active and pending would
 *  otherwise wait for luck. Reconciliation enqueues it at highest priority — runs
 *  even while the paid stream is paused so positions resubscribe FIRST on resume. */
function reconcilePins() {
  const pinned = pinnedSet();
  for (const key of pinned) {
    if (!state.active.has(key) && !state.pendingKeys.has(key)) queueKeys([key], true);
  }
}

function queueKeys(keys: string[], urgent: boolean) {
  const now = Date.now();
  for (const key of keys) {
    if (!key) continue;
    if (state.active.has(key)) {
      state.suppressedDuplicateKeys++;
      continue;
    }
    // Repeated requests move to the back. Single-key requests come from a newly admitted
    // or explicitly surfaced token and receive priority over bulk hydration/reconciliation.
    state.pendingKeys.delete(key);
    state.pendingKeys.set(key, now);
    if (urgent) {
      state.urgentKeys.delete(key);
      state.urgentKeys.set(key, now);
    }
  }
  trimPending();
}

function providerReady(now = Date.now()): boolean {
  if (!state.providerRejected) return true;
  if (state.providerRetryAt && now < state.providerRetryAt) return false;
  state.providerRejected = false;
  state.providerRetryAt = null;
  state.providerRecoveryAttempts++;
  console.warn('[pumpportal-guard] provider cooldown elapsed; retrying paid subscriptions');
  return true;
}

function nextPending(openSlots: number): string[] {
  if (openSlots <= 0) return [];
  const pinned = pinnedSet();
  const pinnedPending = [...state.pendingKeys.keys()].filter(key => pinned.has(key)).slice(0, openSlots);
  const urgent = [pinnedPending, [...state.urgentKeys.keys()].reverse()].flat()
    .filter((key, index, all) => all.indexOf(key) === index).slice(0, openSlots);
  const selected = [...urgent];
  if (selected.length < openSlots) {
    const urgentSet = new Set(urgent);
    const regular = [...state.pendingKeys.keys()].reverse()
      .filter(key => !urgentSet.has(key))
      .slice(0, openSlots - selected.length);
    selected.push(...regular);
  }
  return selected;
}

function fillOpenSlots(socket = guardedSocket) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  if (!providerReady() || !paidStreamBudgetAvailable()) return;
  const openSlots = Math.max(0, MAX_ACTIVE_TOKENS - state.active.size);
  if (!openSlots || !state.pendingKeys.size) return;

  const selected = nextPending(openSlots);
  if (!selected.length) return;
  const now = Date.now();
  for (const key of selected) {
    state.pendingKeys.delete(key);
    state.urgentKeys.delete(key);
    state.active.set(key, { subscribedAt: now, lastEventAt: null });
  }
  sendRaw(socket, { method: 'subscribeTokenTrade', keys: selected });
  state.subscribeCommands++;
  state.rawSubscribedKeys += selected.length;
  state.lastSubscriptionAt = now;
  if (!state.firstPaidSubscriptionAt) state.firstPaidSubscriptionAt = now;
  console.log(`[pumpportal-guard] subscribed ${selected.length} paid token stream(s); active=${state.active.size}`);
}

function unsubscribe(socket: WebSocket, keys: string[]) {
  if (!keys.length || socket.readyState !== WebSocket.OPEN) return;
  sendRaw(socket, { method: 'unsubscribeTokenTrade', keys });
  state.unsubscribeCommands++;
}

function pausePaidStream(socket: WebSocket, reason: 'event_budget' | 'provider_rejection', detail?: string) {
  const active = [...state.active.keys()];
  queueKeys(active, false);
  state.active.clear();
  if (reason === 'event_budget') {
    state.budgetTripped = true;
    state.lastBudgetTripAt = Date.now();
  } else {
    state.providerRejected = true;
    state.providerRejections++;
    state.providerRetryAt = Date.now() + PROVIDER_RETRY_MS;
    state.lastProviderRejection = detail || 'PumpPortal rejected the paid stream';
  }
  unsubscribe(socket, active);
  console.error(`[pumpportal-guard] paid stream paused: ${reason}; active_unsubscribed=${active.length}`);
}

function rotateOneQuietSlot(socket: WebSocket, now: number) {
  const pinned = pinnedSet();
  const pinnedPendingExists = [...state.pendingKeys.keys()].some(key => pinned.has(key));
  if ((!state.urgentKeys.size && !pinnedPendingExists) || state.active.size < MAX_ACTIVE_TOKENS) return;
  if (state.lastRotationAt && now - state.lastRotationAt < ROTATION_INTERVAL_MS) return;
  const quiet = [...state.active.entries()]
    .filter(([key, value]) => !pinned.has(key) && value.lastEventAt === null && now - value.subscribedAt >= QUIET_SLOT_LEASE_MS)
    .sort((left, right) => left[1].subscribedAt - right[1].subscribedAt)[0];
  if (!quiet) return;
  unsubscribe(socket, [quiet[0]]);
  state.active.delete(quiet[0]);
  state.evictedKeys++;
  state.urgentRotations++;
  state.lastRotationAt = now;
}

function maintainStableSlots() {
  const socket = guardedSocket;
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  const now = Date.now();
  state.lastMaintenanceAt = now;
  reconcilePins();
  if (!providerReady(now) || !paidStreamBudgetAvailable()) return;

  // Only a fresh single-token request may replace a slot. Streams that have produced a
  // paid event are never rotated. Bulk reconciler traffic cannot churn provider state.
  rotateOneQuietSlot(socket, now);
  fillOpenSlots(socket);
}

(WebSocket.prototype as any).send = function guardedSend(data: unknown, ...args: unknown[]) {
  if (!isPumpPortalSocket(this)) return (rawSend as any).call(this, data, ...args);
  ensureSocket(this);
  const payload = parsePayload(data);
  if (payload?.method === 'subscribeTokenTrade') {
    const keys = Array.isArray(payload.keys) ? [...new Set<string>(payload.keys.map(String).filter(Boolean))] : [];
    queueKeys(keys, keys.length === 1);
    if (!paidStreamBudgetAvailable()) {
      state.suppressedOverBudgetKeys += keys.length;
      ensurePumpPortalPersistentBudget();
    }
    fillOpenSlots(this);
    return;
  }
  if (payload?.method === 'unsubscribeTokenTrade') {
    // The application removes tokens from its in-memory dashboard aggressively. That is
    // not authority to destroy the evidence stream. Only this guard may unsubscribe for
    // a budget stop, provider rejection, or a controlled silent-slot rotation.
    const keys: string[] = Array.isArray(payload.keys) ? payload.keys.map(String).filter(Boolean) : [];
    state.ignoredApplicationUnsubscribes += keys.length;
    return;
  }
  return (rawSend as any).call(this, data, ...args);
};

(WebSocket.prototype as any).emit = function guardedEmit(event: string, ...args: unknown[]) {
  if (event === 'message' && isPumpPortalSocket(this)) {
    ensureSocket(this);
    const payload = parsePayload(args[0]);
    const txType = String(payload?.txType || '').toLowerCase();
    if (payload?.mint && (txType === 'buy' || txType === 'sell')) {
      const now = Date.now();
      state.paidEvents++;
      state.lastEventAt = now;
      const active = state.active.get(String(payload.mint));
      if (active) active.lastEventAt = now;
      if (!consumePersistentPaidEvent()) pausePaidStream(this, 'event_budget');
    } else {
      const text = payload ? JSON.stringify(payload) : '';
      if (/minimum balance not met|funded with at least 0\.02 sol|insufficient (?:wallet )?balance|balance too low|payment required/i.test(text))
        pausePaidStream(this, 'provider_rejection', text.slice(0, 500));
    }
  }
  return (rawEmit as any).call(this, event, ...args);
};

onPumpPortalBudgetAvailable(() => fillOpenSlots());
ensurePumpPortalPersistentBudget();
const maintenanceTimer = setInterval(maintainStableSlots, MAINTENANCE_INTERVAL_MS);
maintenanceTimer.unref();

export function pumpPortalGuardDiag() {
  const pinned = pinnedSet();
  const pinnedActive = [...state.active.keys()].filter(key => pinned.has(key)).length;
  const pinnedPending = [...state.pendingKeys.keys()].filter(key => pinned.has(key)).length;
  const pinnedMissing = [...pinned].filter(key => !state.active.has(key) && !state.pendingKeys.has(key)).length;

  const persistentBudget = pumpPortalPersistentBudgetDiag();
  const now = Date.now();
  const entitlementWarning = state.paidEvents === 0
    && state.active.size > 0
    && state.firstPaidSubscriptionAt !== null
    && now - state.firstPaidSubscriptionAt >= ENTITLEMENT_WARNING_MS
    ? 'Paid subscriptions are active but no trades arrived. Verify the API key is linked to a PumpPortal wallet funded with at least 0.02 SOL.'
    : null;
  return {
    pinnedProvided: pinned.size, pinnedActive, pinnedPending, pinnedMissing,
    pinnedCache: openPositionsCacheDiag(),
    maxActiveTokens: MAX_ACTIVE_TOKENS,
    maxPendingTokens: MAX_PENDING_TOKENS,
    quietSlotLeaseSeconds: Math.round(QUIET_SLOT_LEASE_MS / 1000),
    rotationIntervalSeconds: Math.round(ROTATION_INTERVAL_MS / 1000),
    providerRetrySeconds: Math.round(PROVIDER_RETRY_MS / 1000),
    entitlementWarningAfterSeconds: Math.round(ENTITLEMENT_WARNING_MS / 1000),
    budgetMode: 'postgres_daily_and_rolling_14d_with_time_aware_pacing',
    pacingStrategy: 'proportional_to_day_remaining',
    subscriptionStrategy: 'single_owner_fresh_priority_no_scanner_unsubscribe',
    activeTokens: state.active.size,
    activeTokenKeys: [...state.active.keys()],
    pendingBudgetKeys: state.pendingKeys.size,
    urgentPendingKeys: state.urgentKeys.size,
    paidEventsThisBoot: state.paidEvents,
    estimatedMeteredCostSol: Number((state.paidEvents / 10_000 * 0.01).toFixed(6)),
    suppressedDuplicateKeys: state.suppressedDuplicateKeys,
    suppressedOverBudgetKeys: state.suppressedOverBudgetKeys,
    suppressedRotationWaitKeys: state.urgentKeys.size,
    suppressedStaleDuringCooldownKeys: 0,
    evictedKeys: state.evictedKeys,
    urgentRotations: state.urgentRotations,
    droppedPendingKeys: state.droppedPendingKeys,
    subscribeCommands: state.subscribeCommands,
    rawSubscribedKeys: state.rawSubscribedKeys,
    unsubscribeCommands: state.unsubscribeCommands,
    ignoredApplicationUnsubscribes: state.ignoredApplicationUnsubscribes,
    budgetTripped: state.budgetTripped,
    providerRejected: state.providerRejected,
    providerRejections: state.providerRejections,
    providerRecoveryAttempts: state.providerRecoveryAttempts,
    lastProviderRejection: state.lastProviderRejection,
    providerRetryAt: state.providerRetryAt ? new Date(state.providerRetryAt).toISOString() : null,
    entitlementWarning,
    socketGenerations: state.socketGenerations,
    startedAt: new Date(state.startedAt).toISOString(),
    lastEventAt: state.lastEventAt ? new Date(state.lastEventAt).toISOString() : null,
    firstPaidSubscriptionAt: state.firstPaidSubscriptionAt ? new Date(state.firstPaidSubscriptionAt).toISOString() : null,
    lastBudgetTripAt: state.lastBudgetTripAt ? new Date(state.lastBudgetTripAt).toISOString() : null,
    lastRotationAt: state.lastRotationAt ? new Date(state.lastRotationAt).toISOString() : null,
    lastSubscriptionAt: state.lastSubscriptionAt ? new Date(state.lastSubscriptionAt).toISOString() : null,
    lastMaintenanceAt: state.lastMaintenanceAt ? new Date(state.lastMaintenanceAt).toISOString() : null,
    persistentBudget,
  };
}

(globalThis as any).__pumpPortalGuardDiag = pumpPortalGuardDiag;
console.log(`[pumpportal-guard] enabled: sole owner of ${MAX_ACTIVE_TOKENS} paid slots; fresh-priority rotation after ${QUIET_SLOT_LEASE_MS / 1000}s`);

export const __guardInternalsForTest = { state, queueKeys, rotateOneQuietSlot, nextPending, trimPending, reconcilePins, MAX_PENDING_TOKENS };
