import WebSocket from 'ws';
import {
  consumePersistentPaidEvent,
  ensurePumpPortalPersistentBudget,
  onPumpPortalBudgetAvailable,
  paidStreamBudgetAvailable,
  pumpPortalPersistentBudgetDiag,
} from './pumpportal-persistent-budget';

// PumpPortal recommends one websocket with subscriptions added to that connection. Paid
// subscriptions therefore stay stable instead of being continuously unsubscribed/re-added.
// The persistent PostgreSQL event budget remains the authoritative spending ceiling.
const MAX_ACTIVE_TOKENS = Math.max(1, Math.min(10, Number(process.env.PUMPPORTAL_MAX_ACTIVE_TOKENS || 10)));
const MAX_PENDING_TOKENS = Math.max(20, Math.min(250, Number(process.env.PUMPPORTAL_MAX_PENDING_TOKENS || 100)));
const PROVIDER_RETRY_MS = Math.max(60_000, Math.min(30 * 60_000, Number(process.env.PUMPPORTAL_PROVIDER_RETRY_MS || 5 * 60_000)));
const QUIET_SLOT_LEASE_MS = Math.max(5 * 60_000, Math.min(60 * 60_000, Number(process.env.PUMPPORTAL_QUIET_SLOT_LEASE_MS || 10 * 60_000)));
const MAINTENANCE_INTERVAL_MS = 30_000;

interface ActiveSubscription {
  subscribedAt: number;
  lastEventAt: number | null;
}

interface PumpPortalGuardState {
  active: Map<string, ActiveSubscription>;
  pendingKeys: Map<string, number>;
  paidEvents: number;
  suppressedDuplicateKeys: number;
  suppressedOverBudgetKeys: number;
  evictedKeys: number;
  droppedPendingKeys: number;
  subscribeCommands: number;
  unsubscribeCommands: number;
  rawSubscribedKeys: number;
  budgetTripped: boolean;
  providerRejected: boolean;
  providerRejections: number;
  providerRecoveryAttempts: number;
  startedAt: number;
  lastEventAt: number | null;
  lastBudgetTripAt: number | null;
  lastProviderRejection: string | null;
  providerRetryAt: number | null;
  lastSubscriptionAt: number | null;
  lastMaintenanceAt: number | null;
  socketGenerations: number;
}

const state: PumpPortalGuardState = {
  active: new Map(),
  pendingKeys: new Map(),
  paidEvents: 0,
  suppressedDuplicateKeys: 0,
  suppressedOverBudgetKeys: 0,
  evictedKeys: 0,
  droppedPendingKeys: 0,
  subscribeCommands: 0,
  unsubscribeCommands: 0,
  rawSubscribedKeys: 0,
  budgetTripped: false,
  providerRejected: false,
  providerRejections: 0,
  providerRecoveryAttempts: 0,
  startedAt: Date.now(),
  lastEventAt: null,
  lastBudgetTripAt: null,
  lastProviderRejection: null,
  providerRetryAt: null,
  lastSubscriptionAt: null,
  lastMaintenanceAt: null,
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
  // A new websocket has no server-side subscriptions. Requeue the prior desired set so
  // reconnection restores it on the same replacement socket.
  const now = Date.now();
  for (const key of state.active.keys()) state.pendingKeys.set(key, now);
  state.active.clear();
  state.socketGenerations++;
}

function trimPending() {
  while (state.pendingKeys.size > MAX_PENDING_TOKENS) {
    const oldest = state.pendingKeys.keys().next().value as string | undefined;
    if (!oldest) break;
    state.pendingKeys.delete(oldest);
    state.droppedPendingKeys++;
  }
}

function queueKeys(keys: string[]) {
  const now = Date.now();
  for (const key of keys) {
    if (!key) continue;
    if (state.active.has(key)) {
      state.suppressedDuplicateKeys++;
      continue;
    }
    // Move repeated pending keys to the back so fresh launch requests receive priority.
    state.pendingKeys.delete(key);
    state.pendingKeys.set(key, now);
  }
  trimPending();
}

function providerReady(now = Date.now()): boolean {
  if (!state.providerRejected) return true;
  if (state.providerRetryAt && now < state.providerRetryAt) return false;
  state.providerRejected = false;
  state.providerRetryAt = null;
  state.providerRecoveryAttempts++;
  console.warn('[pumpportal-guard] provider cooldown elapsed; retrying stable paid subscriptions');
  return true;
}

function fillOpenSlots(socket = guardedSocket) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  if (!providerReady() || !paidStreamBudgetAvailable()) return;
  const openSlots = Math.max(0, MAX_ACTIVE_TOKENS - state.active.size);
  if (!openSlots || !state.pendingKeys.size) return;

  const selected = [...state.pendingKeys.keys()].slice(-openSlots);
  const now = Date.now();
  for (const key of selected) {
    state.pendingKeys.delete(key);
    state.active.set(key, { subscribedAt: now, lastEventAt: null });
  }
  sendRaw(socket, { method: 'subscribeTokenTrade', keys: selected });
  state.subscribeCommands++;
  state.rawSubscribedKeys += selected.length;
  state.lastSubscriptionAt = now;
  console.log(`[pumpportal-guard] subscribed ${selected.length} stable paid token stream(s); active=${state.active.size}`);
}

function unsubscribe(socket: WebSocket, keys: string[]) {
  if (!keys.length || socket.readyState !== WebSocket.OPEN) return;
  sendRaw(socket, { method: 'unsubscribeTokenTrade', keys });
  state.unsubscribeCommands++;
}

function pausePaidStream(socket: WebSocket, reason: 'event_budget' | 'provider_rejection', detail?: string) {
  const active = [...state.active.keys()];
  queueKeys(active);
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

function maintainStableSlots() {
  const socket = guardedSocket;
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  const now = Date.now();
  state.lastMaintenanceAt = now;
  if (!providerReady(now) || !paidStreamBudgetAvailable()) return;

  // Only recycle one slot per maintenance tick, and only when it has stayed completely
  // silent for a long lease. Active streams producing trades are never churned.
  if (state.pendingKeys.size && state.active.size >= MAX_ACTIVE_TOKENS) {
    const quiet = [...state.active.entries()]
      .filter(([, value]) => value.lastEventAt === null && now - value.subscribedAt >= QUIET_SLOT_LEASE_MS)
      .sort((left, right) => left[1].subscribedAt - right[1].subscribedAt)[0];
    if (quiet) {
      unsubscribe(socket, [quiet[0]]);
      state.active.delete(quiet[0]);
      state.evictedKeys++;
    }
  }
  fillOpenSlots(socket);
}

(WebSocket.prototype as any).send = function guardedSend(data: unknown, ...args: unknown[]) {
  if (!isPumpPortalSocket(this)) return (rawSend as any).call(this, data, ...args);
  ensureSocket(this);
  const payload = parsePayload(data);
  if (payload?.method === 'subscribeTokenTrade') {
    const keys = Array.isArray(payload.keys) ? [...new Set<string>(payload.keys.map(String).filter(Boolean))] : [];
    queueKeys(keys);
    if (!paidStreamBudgetAvailable()) {
      state.suppressedOverBudgetKeys += keys.length;
      ensurePumpPortalPersistentBudget();
    }
    fillOpenSlots(this);
    return;
  }
  if (payload?.method === 'unsubscribeTokenTrade') {
    const keys: string[] = Array.isArray(payload.keys) ? payload.keys.map(String) : [];
    for (const key of keys) {
      state.active.delete(key);
      state.pendingKeys.delete(key);
    }
    const result = (rawSend as any).call(this, data, ...args);
    fillOpenSlots(this);
    return result;
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
  const persistentBudget = pumpPortalPersistentBudgetDiag();
  return {
    maxActiveTokens: MAX_ACTIVE_TOKENS,
    maxPendingTokens: MAX_PENDING_TOKENS,
    quietSlotLeaseSeconds: Math.round(QUIET_SLOT_LEASE_MS / 1000),
    providerRetrySeconds: Math.round(PROVIDER_RETRY_MS / 1000),
    budgetMode: 'postgres_daily_and_rolling_14d_with_time_aware_pacing',
    pacingStrategy: 'proportional_to_day_remaining',
    subscriptionStrategy: 'stable_slots_no_churn',
    activeTokens: state.active.size,
    pendingBudgetKeys: state.pendingKeys.size,
    paidEventsThisBoot: state.paidEvents,
    estimatedMeteredCostSol: Number((state.paidEvents / 10_000 * 0.01).toFixed(6)),
    suppressedDuplicateKeys: state.suppressedDuplicateKeys,
    suppressedOverBudgetKeys: state.suppressedOverBudgetKeys,
    suppressedRotationWaitKeys: 0,
    suppressedStaleDuringCooldownKeys: 0,
    evictedKeys: state.evictedKeys,
    droppedPendingKeys: state.droppedPendingKeys,
    subscribeCommands: state.subscribeCommands,
    rawSubscribedKeys: state.rawSubscribedKeys,
    unsubscribeCommands: state.unsubscribeCommands,
    budgetTripped: state.budgetTripped,
    providerRejected: state.providerRejected,
    providerRejections: state.providerRejections,
    providerRecoveryAttempts: state.providerRecoveryAttempts,
    lastProviderRejection: state.lastProviderRejection,
    providerRetryAt: state.providerRetryAt ? new Date(state.providerRetryAt).toISOString() : null,
    socketGenerations: state.socketGenerations,
    startedAt: new Date(state.startedAt).toISOString(),
    lastEventAt: state.lastEventAt ? new Date(state.lastEventAt).toISOString() : null,
    lastBudgetTripAt: state.lastBudgetTripAt ? new Date(state.lastBudgetTripAt).toISOString() : null,
    lastRotationAt: state.lastSubscriptionAt ? new Date(state.lastSubscriptionAt).toISOString() : null,
    lastSubscriptionAt: state.lastSubscriptionAt ? new Date(state.lastSubscriptionAt).toISOString() : null,
    lastMaintenanceAt: state.lastMaintenanceAt ? new Date(state.lastMaintenanceAt).toISOString() : null,
    persistentBudget,
  };
}

(globalThis as any).__pumpPortalGuardDiag = pumpPortalGuardDiag;
console.log(`[pumpportal-guard] enabled: ${MAX_ACTIVE_TOKENS} stable paid slots; ${QUIET_SLOT_LEASE_MS / 60_000}m quiet lease`);
