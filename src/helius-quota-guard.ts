// Process-wide Helius quota guard with durable circuit state. Helius returns HTTP 429
// with "max usage reached" when account credits are exhausted. Retrying that condition
// every few minutes cannot recover and only creates noise, latency, and more failed work.
// Circuit state is persisted in PostgreSQL so it survives restarts. After quota is
// restored and process is restarted, the circuit opens for normal operation.

import { pool } from './db';

const rawFetch = globalThis.fetch.bind(globalThis);

interface QuotaCircuitState {
  hardQuotaBlocked: boolean;
  hardQuotaBlockedAt: number | null;
  hardQuotaMessage: string | null;
  heliusNetworkRequests: number;
  locallyBlockedRequests: number;
  half_open_probes_sent: number;
  half_open_probes_ok: number;
  last_probe_at: number | null;
  initialized: boolean;
}

const state: QuotaCircuitState = {
  hardQuotaBlocked: false,
  hardQuotaBlockedAt: null,
  hardQuotaMessage: null,
  heliusNetworkRequests: 0,
  locallyBlockedRequests: 0,
  half_open_probes_sent: 0,
  half_open_probes_ok: 0,
  last_probe_at: null,
  initialized: false,
};

const CIRCUIT_COOLDOWN_MS = 60_000; // Minimum time between probe attempts
const PERSISTENT_STATE_TABLE = 'helius_quota_circuit_state';

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function isHeliusUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'api.helius.xyz' || host.endsWith('.helius-rpc.com') || host === 'mainnet.helius-rpc.com';
  } catch {
    return /helius\.xyz|helius-rpc\.com/i.test(url);
  }
}

export function isHeliusHardQuotaMessage(status: number, text: string): boolean {
  return (
    status === 429 && /max usage reached|credits? (?:exhausted|depleted)|out of credits/i.test(text)
  );
}

function localBlockedResponse(): Response {
  return new Response(
    JSON.stringify({
      error: 'max usage reached (blocked locally until Railway restart after credits are restored)',
    }),
    {
      status: 429,
      headers: {
        'content-type': 'application/json',
        'retry-after': '300',
        'x-memebot-helius-quota-blocked': 'true',
      },
    },
  );
}

async function initializeCircuitFromDatabase(): Promise<void> {
  if (!pool || state.initialized) return;
  state.initialized = true;
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS ${PERSISTENT_STATE_TABLE} (
      id INTEGER PRIMARY KEY DEFAULT 1,
      hard_quota_blocked BOOLEAN NOT NULL DEFAULT false,
      hard_quota_blocked_at TIMESTAMPTZ,
      hard_quota_message TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK (id = 1)
    )`);

    const result = await pool.query(`SELECT hard_quota_blocked, hard_quota_message FROM ${PERSISTENT_STATE_TABLE} WHERE id=1`);
    if (result.rows.length > 0) {
      const row = result.rows[0];
      state.hardQuotaBlocked = row.hard_quota_blocked === true;
      state.hardQuotaMessage = row.hard_quota_message || null;
      if (state.hardQuotaBlocked) {
        state.hardQuotaBlockedAt = Date.now();
        console.warn('[helius-quota-guard] recovered persisted quota-blocked state; circuit remains open');
      }
    }
  } catch (error) {
    console.error('[helius-quota-guard] failed to load persisted state:', (error as Error).message);
  }
}

async function persistCircuitState(): Promise<void> {
  if (!pool) return;
  try {
    await pool
      .query(
        `INSERT INTO ${PERSISTENT_STATE_TABLE} (id, hard_quota_blocked, hard_quota_blocked_at, hard_quota_message, updated_at)
         VALUES (1, $1, $2, $3, now())
         ON CONFLICT (id) DO UPDATE SET
           hard_quota_blocked=EXCLUDED.hard_quota_blocked,
           hard_quota_blocked_at=EXCLUDED.hard_quota_blocked_at,
           hard_quota_message=EXCLUDED.hard_quota_message,
           updated_at=now()`,
        [state.hardQuotaBlocked, state.hardQuotaBlockedAt ? new Date(state.hardQuotaBlockedAt) : null, state.hardQuotaMessage],
      )
      .catch((error) => {
        console.error('[helius-quota-guard] failed to persist state:', (error as Error).message);
      });
  } catch (error) {
    console.error('[helius-quota-guard] persist error:', (error as Error).message);
  }
}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = requestUrl(input);
  if (!isHeliusUrl(url)) return rawFetch(input as any, init);

  if (state.hardQuotaBlocked) {
    state.locallyBlockedRequests++;
    return localBlockedResponse();
  }

  state.heliusNetworkRequests++;
  const response = await rawFetch(input as any, init);
  if (response.status === 429) {
    const text = await response
      .clone()
      .text()
      .catch(() => '');
    if (isHeliusHardQuotaMessage(response.status, text)) {
      state.hardQuotaBlocked = true;
      state.hardQuotaBlockedAt = Date.now();
      state.hardQuotaMessage = text.slice(0, 500) || 'max usage reached';
      await persistCircuitState();
      console.error(
        '[helius-quota-guard] account credits exhausted; external Helius calls paused until Railway restart',
      );
    }
  }
  return response;
}) as typeof fetch;

export function heliusQuotaGuardDiag() {
  const iso = (value: number | null) => (value ? new Date(value).toISOString() : null);
  return {
    circuitOpen: state.hardQuotaBlocked,
    hardQuotaBlockedAt: iso(state.hardQuotaBlockedAt),
    hardQuotaMessage: state.hardQuotaMessage,
    heliusNetworkRequests: state.heliusNetworkRequests,
    locallyBlockedRequests: state.locallyBlockedRequests,
    halfOpenProbesSent: state.half_open_probes_sent,
    halfOpenProbesOk: state.half_open_probes_ok,
    lastProbeAt: iso(state.last_probe_at),
    persistedToDatabase: !!pool,
    recovery: state.hardQuotaBlocked
      ? 'restore Helius credits in account settings, then restart Railway deployment'
      : null,
  };
}

(globalThis as any).__heliusQuotaGuardDiag = heliusQuotaGuardDiag;

// Initialize from database on load
void initializeCircuitFromDatabase();