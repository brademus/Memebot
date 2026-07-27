import WebSocket from 'ws';
import {
  consumePersistentPaidEvent,
  ensurePumpPortalPersistentBudget,
  onPumpPortalBudgetAvailable,
  paidStreamBudgetAvailable,
  pumpPortalPersistentBudgetDiag,
} from './pumpportal-persistent-budget';

// Paid token subscriptions remain deliberately narrow. The message budget is persisted in
// PostgreSQL, while this guard keeps the ten paid slots useful: fresh one-token requests are
// prioritized, each active token receives a minimum dwell window, and provider rejections are
// retried automatically instead of latching forever after the wallet is funded.
const MAX_ACTIVE_TOKENS = Math.max(1, Math.min(10, Number(process.env.PUMPPORTAL_MAX_ACTIVE_TOKENS || 10)));
const MAX_PENDING_TOKENS = Math.max(20, Math.min(250, Number(process.env.PUMPPORTAL_MAX_PENDING_TOKENS || 100)));
const MIN_ACTIVE_DWELL_MS = Math.max(
  30_000,
  Math.min(5 * 60_000, Number(process.env.PUMPPORTAL_MIN_ACTIVE_DWELL_MS || 60_000)),
);
const ROTATION_INTERVAL_MS = Math.max(
  2_000,
  Math.min(30_000, Number(process.env.PUMPPORTAL_ROTATION_INTERVAL_MS || 5_000)),
);
const MAX_ROTATIONS_PER_TICK = Math.max(
  1,
  Math.min(3, Number(process.env.PUMPPORTAL_MAX_ROTATIONS_PER_TICK || 2)),
);
const PROVIDER_RETRY_MS = Math.max(
  60_000,
  Math.min(30 * 60_000, Number(process.env.PUMPPORTAL_PROVIDER_RETRY_MS || 5 * 60_000)),
);

type PendingPriority = 'fresh' | 'bulk';
interface PendingKey {
  requestedAt: number;
  priority: PendingPriority;
}

interface PumpPortalGuardState {
  active: Map<string, number>;
  pendingKeys: Map<string, PendingKey>;
  paidEvents: number;
  suppressedDuplicateKeys: number;
  suppressedOverBudgetKeys: number;
  suppressedRotationWaitKeys: number;
  evictedKeys: number;
  droppedPendingKeys: number;
  subscribeCommands: number;
  unsubscribeCommands: number;
  budgetTripped: boolean;
  providerRejected: boolean;
  providerRejections: number;
  providerRecoveryAttempts: number;
  startedAt: number;
  lastEventAt: number | null;
  lastBudgetTripAt: number | null;
  lastProviderRejection: string | null;
  providerRetryAt: number | null;
  lastRotationAt: number | null;
  socketGenerations: number;
}

const state: PumpPortalGuardState = {
  active: new Map(),
  pendingKeys: new Map(),
  paidEvents: 0,
  suppressedDuplicateKeys: 0,
  suppressedOverBudgetKeys: 0,
  suppressedRotationWaitKeys: 0,
  evictedKeys: 0,
  droppedPendingKeys: 0,
  subscribeCommands: 0,
  unsubscribeCommands: 0,
  budgetTripped: false,
  providerRejected: false,
  providerRejections: 0,
  providerRecoveryAttempts: 0,
  startedAt: Date.now(),
  lastEventAt: null,
  lastBudgetTripAt: null,
  lastProviderRejection: null,
  providerRetryAt: null,
  lastRotationAt: null,
  socketGenerations: 0,
};

const isPumpPortalSocket = (socket: any) => String(socket?.url || '').includes('pumpportal.fun/api/data');
const rawSend = WebSocket.prototype.send;
const rawEmit = WebSocket.prototype.emit;
let guardedSocket: WebSocket | null = null;

function ensureSocket(socket: WebSocket) {
  if (socket === guardedSocket) return;
  guardedSocket = socket;
  state.active.clear();
  state.socketGenerations++;
}

function parsePayload(value: unknown): any | null {
  try {
    if (typeof value === 'string') return JSON.parse(value);
    if (Buffer.isBuffer(value)) return JSON.parse(value.toString('utf8'));
    if (value instanceof ArrayBuffer) return JSON.parse(Buffer.from(value).toString('utf8'));
    if (ArrayBuffer.isView(value))
      return JSON.parse(Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('utf8'));
  } catch {}
  return null;
}

function sendRaw(socket: WebSocket, payload: unknown) {
  (rawSend as any).call(socket, JSON.stringify(payload));
}

function unsubscribe(socket: WebSocket, keys: string[]) {
  if (!keys.length || socket.readyState !== WebSocket.OPEN) return;
  sendRaw(socket, { method: 'unsubscribeTokenTrade', keys });
  state.unsubscribeCommands++;
}

function trimPendingQueue() {
  while (state.pendingKeys.size > MAX_PENDING_TOKENS) {
    const bulk = [...state.pendingKeys.entries()].find(([, value]) => value.priority === 'bulk');
    const oldest = bulk || state.pendingKeys.entries().next().value;
    if (!oldest) break;
    state.pendingKeys.delete(oldest[0]);
    state.droppedPendingKeys++;
  }
}

function queueKeys(keys: string[], priority: PendingPriority) {
  const now = Date.now();
  for (const key of keys) {
    if (!key) continue;
    if (state.active.has(key)) {
      state.suppressedDuplicateKeys++;
      continue;
    }
    const existing = state.pendingKeys.get(key);
    if (existing) state.pendingKeys.delete(key);
    state.pendingKeys.set(key, {
      requestedAt: now,
      priority: existing?.priority === 'fresh' || priority === 'fresh' ? 'fresh' : 'bulk',
    });
  }
  trimPendingQueue();
}

function takePending(count: number): string[] {
  if (count <= 0 || !state.pendingKeys.size) return [];
  const selected = [...state.pendingKeys.entries()]
    .sort((left, right) => {
      const priority = Number(right[1].priority === 'fresh') - Number(left[1].priority === 'fresh');
      return priority || right[1].requestedAt - left[1].requestedAt;
    })
    .slice(0, count)
    .map(([key]) => key);
  for (const key of selected) state.pendingKeys.delete(key);
  return selected;
}

function providerReady(now = Date.now()): boolean {
  if (!state.providerRejected) return true;
  if (state.providerRetryAt && now < state.providerRetryAt) return false;
  state.providerRejected = false;
  state.providerRetryAt = null;
  state.providerRecoveryAttempts++;
  console.warn('[pumpportal-guard] provider rejection cooldown elapsed; retrying paid subscriptions');
  return true;
}

function rotateSubscriptions(socket = guardedSocket) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  const now = Date.now();
  if (!providerReady(now) || !paidStreamBudgetAvailable()) return;
  if (!state.pendingKeys.size) return;

  const openSlots = Math.max(0, MAX_ACTIVE_TOKENS - state.active.size);
  let accepted = takePending(openSlots);

  if (state.pendingKeys.size && state.active.size >= MAX_ACTIVE_TOKENS) {
    const evictable = [...state.active.entries()]
      .filter(([, subscribedAt]) => now - subscribedAt >= MIN_ACTIVE_DWELL_MS)
      .sort((left, right) => left[1] - right[1])
      .slice(0, MAX_ROTATIONS_PER_TICK)
      .map(([key]) => key);
    if (evictable.length) {
      unsubscribe(socket, evictable);
      for (const key of evictable) state.active.delete(key);
      state.evictedKeys += evictable.length;
      accepted = accepted.concat(takePending(evictable.length));
    } else {
      state.suppressedRotationWaitKeys += state.pendingKeys.size;
    }
  }

  accepted = [...new Set(accepted)].filter(key => !state.active.has(key));
  if (!accepted.length) return;
  for (const key of accepted) state.active.set(key, now);
  sendRaw(socket, { method: 'subscribeTokenTrade', keys: accepted });
  state.subscribeCommands++;
  state.lastRotationAt = now;
}

function tripBudget(socket: WebSocket, reason: 'event_budget' | 'provider_rejection', detail?: string) {
  const active = [...state.active.keys()];
  queueKeys(active, 'bulk');
  state.active.clear();

  if (reason === 'event_budget') {
    if (state.budgetTripped) return;
    state.budgetTripped = true;
    state.lastBudgetTripAt = Date.now();
  } else {
    state.providerRejected = true;
    state.providerRejections++;
    state.providerRetryAt = Date.now() + PROVIDER_RETRY_MS;
    state.lastProviderRejection = detail || 'PumpPortal rejected the paid stream';
  }

  unsubscribe(socket, active);
  console.error(
    `[pumpportal-guard] paid stream paused: ${reason}; events=${state.paidEvents}; active_unsubscribed=${active.length}`,
  );
}

function guardedSubscription(socket: WebSocket, payload: any): boolean {
  const keys: string[] = Array.isArray(payload?.keys) ? payload.keys.map(String).filter(Boolean) : [];
  if (!keys.length) return true;
  const priority: PendingPriority = keys.length <= 2 ? 'fresh' : 'bulk';
  queueKeys([...new Set(keys)], priority);

  if (!providerReady()) {
    state.suppressedOverBudgetKeys += keys.length;
    return false;
  }
  if (!paidStreamBudgetAvailable()) {
    state.suppressedOverBudgetKeys += keys.length;
    ensurePumpPortalPersistentBudget();
    return false;
  }

  state.budgetTripped = false;
  rotateSubscriptions(socket);
  return false;
}

(WebSocket.prototype as any).send = function guardedSend(data: unknown, ...args: unknown[]) {
  if (!isPumpPortalSocket(this)) return (rawSend as any).call(this, data, ...args);
  ensureSocket(this);
  const payload = parsePayload(data);
  if (payload?.method === 'subscribeTokenTrade') {
    guardedSubscription(this, payload);
    return;
  }
  if (payload?.method === 'unsubscribeTokenTrade') {
    const keys: string[] = Array.isArray(payload.keys) ? payload.keys.map(String) : [];
    for (const key of keys) {
      state.active.delete(key);
      state.pendingKeys.delete(key);
    }
  }
  return (rawSend as any).call(this, data, ...args);
};

(WebSocket.prototype as any).emit = function guardedEmit(event: string, ...args: unknown[]) {
  if (event === 'message' && isPumpPortalSocket(this)) {
    ensureSocket(this);
    const payload = parsePayload(args[0]);
    const txType = String(payload?.txType || '').toLowerCase();
    if (payload?.mint && (txType === 'buy' || txType === 'sell')) {
      state.paidEvents++;
      state.lastEventAt = Date.now();
      if (!consumePersistentPaidEvent()) tripBudget(this, 'event_budget');
    } else {
      const text = payload ? JSON.stringify(payload) : '';
      if (/minimum balance not met|funded with at least 0\.02 sol|insufficient (?:wallet )?balance|balance too low|payment required/i.test(text))
        tripBudget(this, 'provider_rejection', text.slice(0, 500));
    }
  }
  return (rawEmit as any).call(this, event, ...args);
};

onPumpPortalBudgetAvailable(() => rotateSubscriptions());
ensurePumpPortalPersistentBudget();
const rotationTimer = setInterval(() => rotateSubscriptions(), ROTATION_INTERVAL_MS);
rotationTimer.unref();

export function pumpPortalGuardDiag() {
  const persistentBudget = pumpPortalPersistentBudgetDiag();
  return {
    maxActiveTokens: MAX_ACTIVE_TOKENS,
    maxPendingTokens: MAX_PENDING_TOKENS,
    minActiveDwellSeconds: Math.round(MIN_ACTIVE_DWELL_MS / 1000),
    rotationIntervalSeconds: Number((ROTATION_INTERVAL_MS / 1000).toFixed(1)),
    maxRotationsPerTick: MAX_ROTATIONS_PER_TICK,
    providerRetrySeconds: Math.round(PROVIDER_RETRY_MS / 1000),
    budgetMode: 'postgres_daily_and_rolling_14d_with_time_aware_pacing',
    pacingStrategy: 'proportional_to_day_remaining',
    subscriptionStrategy: 'fresh_priority_queue_with_minimum_dwell',
    activeTokens: state.active.size,
    pendingBudgetKeys: state.pendingKeys.size,
    paidEventsThisBoot: state.paidEvents,
    estimatedMeteredCostSol: Number((state.paidEvents / 10_000 * 0.01).toFixed(6)),
    suppressedDuplicateKeys: state.suppressedDuplicateKeys,
    suppressedOverBudgetKeys: state.suppressedOverBudgetKeys,
    suppressedRotationWaitKeys: state.suppressedRotationWaitKeys,
    suppressedStaleDuringCooldownKeys: 0,
    evictedKeys: state.evictedKeys,
    droppedPendingKeys: state.droppedPendingKeys,
    subscribeCommands: state.subscribeCommands,
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
    lastRotationAt: state.lastRotationAt ? new Date(state.lastRotationAt).toISOString() : null,
    persistentBudget,
  };
}

(globalThis as any).__pumpPortalGuardDiag = pumpPortalGuardDiag;
const budget = pumpPortalPersistentBudgetDiag();
console.log(
  `[pumpportal-guard] enabled: max ${MAX_ACTIVE_TOKENS} paid token streams; ${Math.round(MIN_ACTIVE_DWELL_MS / 1000)}s minimum dwell; persistent daily cap ${budget.dailyEventLimit} events; rolling 14-day cap ${budget.rolling14dEventLimit} events (${budget.maxRolling14dCostSol} SOL maximum)`,
);
