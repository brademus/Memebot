// Process-wide Helius quota guard with durable circuit state. Helius returns HTTP 429
// with "max usage reached" when account credits are exhausted. Retrying every scanner
// cycle cannot recover, but permanently latching the circuit also prevents recovery after
// credits are restored or the Railway API key is replaced. This guard therefore fails fast
// while blocked and sends one controlled half-open probe on a long cooldown.

import { createHash } from 'node:crypto';
import { pool } from './db';
import { env } from './config';

const rawFetch = globalThis.fetch.bind(globalThis);
const PROBE_COOLDOWN_MS = Math.max(
  5 * 60_000,
  Math.min(60 * 60_000, Number(process.env.HELIUS_QUOTA_PROBE_MS || 15 * 60_000)),
);
const PERSISTENT_STATE_TABLE = 'helius_quota_circuit_state';
const apiKeyFingerprint = env.HELIUS_API_KEY
  ? createHash('sha256').update(env.HELIUS_API_KEY.trim()).digest('hex').slice(0, 12)
  : null;

interface QuotaCircuitState {
  hardQuotaBlocked: boolean;
  hardQuotaBlockedAt: number | null;
  hardQuotaMessage: string | null;
  heliusNetworkRequests: number;
  locallyBlockedRequests: number;
  halfOpenProbesSent: number;
  halfOpenProbesOk: number;
  lastProbeAt: number | null;
  initialized: boolean;
  lastRecoveryAt: number | null;
  lastRecoveryReason: string | null;
  lastError: string | null;
}

const state: QuotaCircuitState = {
  hardQuotaBlocked: false,
  hardQuotaBlockedAt: null,
  hardQuotaMessage: null,
  heliusNetworkRequests: 0,
  locallyBlockedRequests: 0,
  halfOpenProbesSent: 0,
  halfOpenProbesOk: 0,
  lastProbeAt: null,
  initialized: false,
  lastRecoveryAt: null,
  lastRecoveryReason: null,
  lastError: null,
};

let initializationPromise: Promise<void> | null = null;
let probeInFlight = false;

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
  return status === 429 && /max usage reached|credits? (?:exhausted|depleted)|out of credits/i.test(text);
}

export function shouldAttemptHeliusProbe(
  blocked: boolean,
  lastProbeAt: number | null,
  now = Date.now(),
  cooldownMs = PROBE_COOLDOWN_MS,
): boolean {
  return blocked && !probeInFlight && (lastProbeAt === null || now - lastProbeAt >= cooldownMs);
}

function nextProbeAt(): number | null {
  if (!state.hardQuotaBlocked) return null;
  return state.lastProbeAt === null ? Date.now() : state.lastProbeAt + PROBE_COOLDOWN_MS;
}

function localBlockedResponse(): Response {
  const next = nextProbeAt();
  const retrySeconds = Math.max(1, Math.ceil(((next || Date.now()) - Date.now()) / 1000));
  return new Response(
    JSON.stringify({
      error: 'helius hard quota blocked locally; automatic recovery probe scheduled',
      retryAfterSeconds: retrySeconds,
    }),
    {
      status: 429,
      headers: {
        'content-type': 'application/json',
        'retry-after': String(retrySeconds),
        'x-memebot-helius-quota-blocked': 'true',
      },
    },
  );
}

async function persistCircuitState(): Promise<void> {
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO ${PERSISTENT_STATE_TABLE}
         (id, hard_quota_blocked, hard_quota_blocked_at, hard_quota_message,
          api_key_fingerprint, last_probe_at, updated_at)
       VALUES (1, $1, $2, $3, $4, $5, now())
       ON CONFLICT (id) DO UPDATE SET
         hard_quota_blocked=EXCLUDED.hard_quota_blocked,
         hard_quota_blocked_at=EXCLUDED.hard_quota_blocked_at,
         hard_quota_message=EXCLUDED.hard_quota_message,
         api_key_fingerprint=EXCLUDED.api_key_fingerprint,
         last_probe_at=EXCLUDED.last_probe_at,
         updated_at=now()`,
      [
        state.hardQuotaBlocked,
        state.hardQuotaBlockedAt ? new Date(state.hardQuotaBlockedAt) : null,
        state.hardQuotaMessage,
        apiKeyFingerprint,
        state.lastProbeAt ? new Date(state.lastProbeAt) : null,
      ],
    );
    state.lastError = null;
  } catch (error) {
    state.lastError = (error as Error).message.slice(0, 300);
    console.error('[helius-quota-guard] failed to persist state:', state.lastError);
  }
}

async function clearHardQuotaBlock(reason: string): Promise<void> {
  const wasBlocked = state.hardQuotaBlocked;
  state.hardQuotaBlocked = false;
  state.hardQuotaBlockedAt = null;
  state.hardQuotaMessage = null;
  state.lastRecoveryAt = Date.now();
  state.lastRecoveryReason = reason;
  if (wasBlocked) console.log(`[helius-quota-guard] quota circuit recovered: ${reason}`);
  await persistCircuitState();
}

function initializeCircuitFromDatabase(): Promise<void> {
  if (state.initialized) return Promise.resolve();
  if (initializationPromise) return initializationPromise;
  initializationPromise = (async () => {
    try {
      if (!pool) {
        state.initialized = true;
        return;
      }
      await pool.query(`CREATE TABLE IF NOT EXISTS ${PERSISTENT_STATE_TABLE} (
        id INTEGER PRIMARY KEY DEFAULT 1,
        hard_quota_blocked BOOLEAN NOT NULL DEFAULT false,
        hard_quota_blocked_at TIMESTAMPTZ,
        hard_quota_message TEXT,
        api_key_fingerprint TEXT,
        last_probe_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CHECK (id = 1)
      )`);
      await pool.query(`ALTER TABLE ${PERSISTENT_STATE_TABLE}
        ADD COLUMN IF NOT EXISTS api_key_fingerprint TEXT,
        ADD COLUMN IF NOT EXISTS last_probe_at TIMESTAMPTZ`);
      const result = await pool.query(
        `SELECT hard_quota_blocked, hard_quota_blocked_at, hard_quota_message,
                api_key_fingerprint, last_probe_at
           FROM ${PERSISTENT_STATE_TABLE} WHERE id=1`,
      );
      if (result.rows.length > 0) {
        const row = result.rows[0];
        const storedFingerprint = row.api_key_fingerprint || null;
        const keyChanged = Boolean(apiKeyFingerprint && storedFingerprint !== apiKeyFingerprint);
        if (row.hard_quota_blocked === true && !keyChanged) {
          state.hardQuotaBlocked = true;
          state.hardQuotaBlockedAt = row.hard_quota_blocked_at
            ? new Date(row.hard_quota_blocked_at).getTime()
            : Date.now();
          state.hardQuotaMessage = row.hard_quota_message || 'max usage reached';
          state.lastProbeAt = row.last_probe_at ? new Date(row.last_probe_at).getTime() : null;
          console.warn('[helius-quota-guard] recovered quota-blocked state; automatic half-open probes remain enabled');
        } else if (row.hard_quota_blocked === true && keyChanged) {
          state.lastRecoveryAt = Date.now();
          state.lastRecoveryReason = storedFingerprint
            ? 'HELIUS_API_KEY fingerprint changed'
            : 'legacy quota latch revalidated';
          await persistCircuitState();
          console.log('[helius-quota-guard] cleared stale quota latch so the current Helius key can be tested');
        }
      }
      state.lastError = null;
    } catch (error) {
      state.lastError = (error as Error).message.slice(0, 300);
      console.error('[helius-quota-guard] failed to load persisted state:', state.lastError);
    } finally {
      state.initialized = true;
      initializationPromise = null;
    }
  })();
  return initializationPromise;
}

async function readResponseText(response: Response): Promise<string> {
  return response.clone().text().catch(() => '');
}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = requestUrl(input);
  if (!isHeliusUrl(url)) return rawFetch(input as any, init);

  await initializeCircuitFromDatabase();
  const probing = shouldAttemptHeliusProbe(state.hardQuotaBlocked, state.lastProbeAt);
  if (state.hardQuotaBlocked && !probing) {
    state.locallyBlockedRequests++;
    return localBlockedResponse();
  }

  if (probing) {
    probeInFlight = true;
    state.halfOpenProbesSent++;
    state.lastProbeAt = Date.now();
  }

  state.heliusNetworkRequests++;
  try {
    const response = await rawFetch(input as any, init);
    const text = response.status === 429 || probing ? await readResponseText(response) : '';
    const hardQuota = isHeliusHardQuotaMessage(response.status, text);

    if (hardQuota) {
      state.hardQuotaBlocked = true;
      state.hardQuotaBlockedAt = Date.now();
      state.hardQuotaMessage = text.slice(0, 500) || 'max usage reached';
      await persistCircuitState();
      console.error('[helius-quota-guard] account credits exhausted; external Helius calls paused with automatic probes');
    } else if (probing) {
      state.halfOpenProbesOk++;
      await clearHardQuotaBlock(response.ok
        ? 'half-open probe succeeded'
        : `half-open probe returned non-quota HTTP ${response.status}`);
    }
    return response;
  } catch (error) {
    state.lastError = (error as Error).message.slice(0, 300);
    throw error;
  } finally {
    if (probing) probeInFlight = false;
  }
}) as typeof fetch;

export function heliusQuotaGuardDiag() {
  const iso = (value: number | null) => (value ? new Date(value).toISOString() : null);
  const next = nextProbeAt();
  return {
    circuitOpen: state.hardQuotaBlocked,
    hardQuotaBlockedAt: iso(state.hardQuotaBlockedAt),
    hardQuotaMessage: state.hardQuotaMessage,
    heliusNetworkRequests: state.heliusNetworkRequests,
    locallyBlockedRequests: state.locallyBlockedRequests,
    halfOpenProbesSent: state.halfOpenProbesSent,
    halfOpenProbesOk: state.halfOpenProbesOk,
    probeInFlight,
    probeCooldownSeconds: Math.round(PROBE_COOLDOWN_MS / 1000),
    lastProbeAt: iso(state.lastProbeAt),
    nextProbeAt: iso(next),
    automaticRecovery: true,
    apiKeyFingerprint,
    lastRecoveryAt: iso(state.lastRecoveryAt),
    lastRecoveryReason: state.lastRecoveryReason,
    persistedToDatabase: !!pool,
    lastError: state.lastError,
    recovery: state.hardQuotaBlocked
      ? 'restore Helius credits or replace HELIUS_API_KEY; Memebot will test recovery automatically'
      : null,
  };
}

(globalThis as any).__heliusQuotaGuardDiag = heliusQuotaGuardDiag;
void initializeCircuitFromDatabase();
