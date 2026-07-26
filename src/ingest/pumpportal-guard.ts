import WebSocket from 'ws';
import {
  consumePersistentPaidEvent,
  ensurePumpPortalPersistentBudget,
  onPumpPortalBudgetAvailable,
  paidStreamBudgetAvailable,
  pumpPortalPersistentBudgetDiag,
} from './pumpportal-persistent-budget';

// Paid token subscriptions are intentionally narrow. The actual paid-message ceiling is
// persisted in PostgreSQL by pumpportal-persistent-budget.ts, so Railway restarts cannot
// reset the daily or rolling 14-day allowance.
const MAX_ACTIVE_TOKENS = Math.max(1, Math.min(10, Number(process.env.PUMPPORTAL_MAX_ACTIVE_TOKENS || 10)));

interface PumpPortalGuardState {
  active: Map<string, number>;
  pendingKeys: Set<string>;
  paidEvents: number;
  suppressedDuplicateKeys: number;
  suppressedOverBudgetKeys: number;
  evictedKeys: number;
  subscribeCommands: number;
  unsubscribeCommands: number;
  budgetTripped: boolean;
  providerRejected: boolean;
  startedAt: number;
  lastEventAt: number | null;
  lastBudgetTripAt: number | null;
  lastProviderRejection: string | null;
  socketGenerations: number;
}

const state: PumpPortalGuardState = {
  active: new Map(),
  pendingKeys: new Set(),
  paidEvents: 0,
  suppressedDuplicateKeys: 0,
  suppressedOverBudgetKeys: 0,
  evictedKeys: 0,
  subscribeCommands: 0,
  unsubscribeCommands: 0,
  budgetTripped: false,
  providerRejected: false,
  startedAt: Date.now(),
  lastEventAt: null,
  lastBudgetTripAt: null,
  lastProviderRejection: null,
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
    if (ArrayBuffer.isView(value)) return JSON.parse(Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('utf8'));
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

function queueForBudget(keys: string[]) {
  for (const key of keys) state.pendingKeys.add(key);
  const retained = [...state.pendingKeys].slice(-MAX_ACTIVE_TOKENS);
  state.pendingKeys.clear();
  for (const key of retained) state.pendingKeys.add(key);
}

function tripBudget(socket: WebSocket, reason: 'event_budget' | 'provider_rejection', detail?: string) {
  if (reason === 'event_budget') {
    if (state.budgetTripped) return;
    state.budgetTripped = true;
    state.lastBudgetTripAt = Date.now();
    queueForBudget([...state.active.keys()]);
  } else {
    if (state.providerRejected) return;
    state.providerRejected = true;
    state.lastProviderRejection = detail || 'PumpPortal rejected the paid stream';
  }
  const active = [...state.active.keys()];
  state.active.clear();
  unsubscribe(socket, active);
  console.error(`[pumpportal-guard] paid stream paused: ${reason}; events=${state.paidEvents}; active_unsubscribed=${active.length}`);
}

function guardedSubscription(socket: WebSocket, payload: any): boolean {
  const keys: string[] = Array.isArray(payload?.keys) ? payload.keys.map(String).filter(Boolean) : [];
  if (!keys.length) return true;
  if (state.providerRejected) {
    state.suppressedOverBudgetKeys += keys.length;
    return false;
  }
  if (!paidStreamBudgetAvailable()) {
    queueForBudget(keys);
    state.suppressedOverBudgetKeys += keys.length;
    ensurePumpPortalPersistentBudget();
    return false;
  }

  state.budgetTripped = false;
  const uniqueNew: string[] = [...new Set<string>(keys)].filter(key => {
    if (state.active.has(key)) {
      state.suppressedDuplicateKeys++;
      return false;
    }
    return true;
  });
  if (!uniqueNew.length) return false;

  const combined: string[] = [...state.active.keys(), ...uniqueNew];
  const desired: string[] = combined.slice(-MAX_ACTIVE_TOKENS);
  const desiredSet = new Set<string>(desired);
  const evicted = [...state.active.keys()].filter(key => !desiredSet.has(key));
  if (evicted.length) {
    unsubscribe(socket, evicted);
    state.evictedKeys += evicted.length;
    for (const key of evicted) state.active.delete(key);
  }

  const accepted = uniqueNew.filter(key => desiredSet.has(key));
  for (const key of accepted) state.active.set(key, Date.now());
  if (!accepted.length) return false;
  sendRaw(socket, { method: 'subscribeTokenTrade', keys: accepted });
  state.subscribeCommands++;
  return false;
}

function flushPendingSubscriptions() {
  const socket = guardedSocket;
  if (!socket || socket.readyState !== WebSocket.OPEN || state.providerRejected || !paidStreamBudgetAvailable()) return;
  const keys = [...state.pendingKeys];
  if (!keys.length) return;
  state.pendingKeys.clear();
  state.budgetTripped = false;
  guardedSubscription(socket, { method: 'subscribeTokenTrade', keys });
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
      if (/minimum balance not met|funded with at least 0\.02 sol/i.test(text))
        tripBudget(this, 'provider_rejection', text.slice(0, 500));
    }
  }
  return (rawEmit as any).call(this, event, ...args);
};

onPumpPortalBudgetAvailable(() => flushPendingSubscriptions());
ensurePumpPortalPersistentBudget();

export function pumpPortalGuardDiag() {
  const persistentBudget = pumpPortalPersistentBudgetDiag();
  return {
    maxActiveTokens: MAX_ACTIVE_TOKENS,
    budgetMode: 'postgres_daily_and_rolling_14d',
    maxPaidEventsPerBoot: null,
    maxEstimatedCostPerBootSol: null,
    activeTokens: state.active.size,
    pendingBudgetKeys: state.pendingKeys.size,
    paidEventsThisBoot: state.paidEvents,
    estimatedMeteredCostSol: Number((state.paidEvents / 10_000 * 0.01).toFixed(6)),
    suppressedDuplicateKeys: state.suppressedDuplicateKeys,
    suppressedOverBudgetKeys: state.suppressedOverBudgetKeys,
    evictedKeys: state.evictedKeys,
    subscribeCommands: state.subscribeCommands,
    unsubscribeCommands: state.unsubscribeCommands,
    budgetTripped: state.budgetTripped,
    providerRejected: state.providerRejected,
    lastProviderRejection: state.lastProviderRejection,
    socketGenerations: state.socketGenerations,
    startedAt: new Date(state.startedAt).toISOString(),
    lastEventAt: state.lastEventAt ? new Date(state.lastEventAt).toISOString() : null,
    lastBudgetTripAt: state.lastBudgetTripAt ? new Date(state.lastBudgetTripAt).toISOString() : null,
    persistentBudget,
  };
}

(globalThis as any).__pumpPortalGuardDiag = pumpPortalGuardDiag;
const budget = pumpPortalPersistentBudgetDiag();
console.log(`[pumpportal-guard] enabled: max ${MAX_ACTIVE_TOKENS} paid token streams; persistent daily cap ${budget.dailyEventLimit} events; rolling 14-day cap ${budget.rolling14dEventLimit} events (${budget.maxRolling14dCostSol} SOL maximum)`);
