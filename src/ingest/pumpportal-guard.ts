import WebSocket from 'ws';

const MAX_ACTIVE_TOKENS = Math.max(1, Math.min(250, Number(process.env.PUMPPORTAL_MAX_ACTIVE_TOKENS || 25)));
const MAX_PAID_EVENTS_PER_BOOT = Math.max(1000, Math.min(100_000,
  Number(process.env.PUMPPORTAL_MAX_PAID_EVENTS_PER_BOOT || 8000)));

interface PumpPortalGuardState {
  active: Map<string, number>;
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
}

const state: PumpPortalGuardState = {
  active: new Map(),
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
};

const isPumpPortalSocket = (socket: any) => String(socket?.url || '').includes('pumpportal.fun/api/data');
const rawSend = WebSocket.prototype.send;
const rawEmit = WebSocket.prototype.emit;

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

function tripBudget(socket: WebSocket, reason: 'event_budget' | 'provider_rejection', detail?: string) {
  if (reason === 'event_budget') {
    if (state.budgetTripped) return;
    state.budgetTripped = true;
    state.lastBudgetTripAt = Date.now();
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
  if (state.budgetTripped || state.providerRejected) {
    state.suppressedOverBudgetKeys += keys.length;
    return false;
  }

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

(WebSocket.prototype as any).send = function guardedSend(data: unknown, ...args: unknown[]) {
  if (!isPumpPortalSocket(this)) return (rawSend as any).call(this, data, ...args);
  const payload = parsePayload(data);
  if (payload?.method === 'subscribeTokenTrade') {
    guardedSubscription(this, payload);
    return;
  }
  if (payload?.method === 'unsubscribeTokenTrade') {
    const keys: string[] = Array.isArray(payload.keys) ? payload.keys.map(String) : [];
    for (const key of keys) state.active.delete(key);
  }
  return (rawSend as any).call(this, data, ...args);
};

(WebSocket.prototype as any).emit = function guardedEmit(event: string, ...args: unknown[]) {
  if (event === 'message' && isPumpPortalSocket(this)) {
    const payload = parsePayload(args[0]);
    const txType = String(payload?.txType || '').toLowerCase();
    if (payload?.mint && (txType === 'buy' || txType === 'sell')) {
      state.paidEvents++;
      state.lastEventAt = Date.now();
      if (state.paidEvents >= MAX_PAID_EVENTS_PER_BOOT) tripBudget(this, 'event_budget');
    } else {
      const text = payload ? JSON.stringify(payload) : '';
      if (/minimum balance not met|funded with at least 0\.02 sol/i.test(text))
        tripBudget(this, 'provider_rejection', text.slice(0, 500));
    }
  }
  return (rawEmit as any).call(this, event, ...args);
};

export function pumpPortalGuardDiag() {
  return {
    maxActiveTokens: MAX_ACTIVE_TOKENS,
    maxPaidEventsPerBoot: MAX_PAID_EVENTS_PER_BOOT,
    activeTokens: state.active.size,
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
    startedAt: new Date(state.startedAt).toISOString(),
    lastEventAt: state.lastEventAt ? new Date(state.lastEventAt).toISOString() : null,
    lastBudgetTripAt: state.lastBudgetTripAt ? new Date(state.lastBudgetTripAt).toISOString() : null,
  };
}

(globalThis as any).__pumpPortalGuardDiag = pumpPortalGuardDiag;
console.log(`[pumpportal-guard] enabled: max ${MAX_ACTIVE_TOKENS} paid token streams; ${MAX_PAID_EVENTS_PER_BOOT} paid events per boot`);
