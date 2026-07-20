import { fetchTokenSnapshot } from '../ingest/dexscreener';

export interface RecoveredPaperMark {
  price: number;
  liquidityUsd: number;
  mcapUsd: number;
  source: 'dexscreener_recovery';
  recoveredAt: number;
}

const CACHE_TTL_MS = 20_000;
export const TRACKING_LOST_GRACE_MS = 6 * 60 * 60_000;

const cache = new Map<string, { expiresAt: number; value: RecoveredPaperMark | null }>();
const inFlight = new Map<string, Promise<RecoveredPaperMark | null>>();

const diag = {
  attempts: 0,
  successes: 0,
  misses: 0,
  cacheHits: 0,
  deduped: 0,
  graceDeferrals: 0,
  trackingLostAfterGrace: 0,
  lastRecoveryAt: null as string | null,
  lastRecoveryCa: null as string | null,
  lastMissAt: null as string | null,
};

export const trackingRecoveryDiag = () => ({
  ...diag,
  cacheEntries: cache.size,
  inFlight: inFlight.size,
  graceHours: TRACKING_LOST_GRACE_MS / 3_600_000,
  successPct: diag.attempts ? Math.round(diag.successes / diag.attempts * 100) : 0,
});

export function shouldDeclareTrackingLost(
  lastSuccessfulAt: string | number | Date | null | undefined,
  now = Date.now(),
  graceMs = TRACKING_LOST_GRACE_MS,
): boolean {
  if (!lastSuccessfulAt) return false;
  const last = lastSuccessfulAt instanceof Date
    ? lastSuccessfulAt.getTime()
    : typeof lastSuccessfulAt === 'number'
      ? lastSuccessfulAt
      : Date.parse(lastSuccessfulAt);
  if (!Number.isFinite(last)) return false;
  return now - last >= graceMs;
}

export const noteTrackingGraceDeferral = () => { diag.graceDeferrals++; };
export const noteTrackingLostAfterGrace = () => { diag.trackingLostAfterGrace++; };

export async function recoverPaperMark(ca: string): Promise<RecoveredPaperMark | null> {
  const now = Date.now();
  const cached = cache.get(ca);
  if (cached && cached.expiresAt > now) {
    diag.cacheHits++;
    return cached.value;
  }
  if (cached) cache.delete(ca);

  const existing = inFlight.get(ca);
  if (existing) {
    diag.deduped++;
    return existing;
  }

  const request = (async () => {
    diag.attempts++;
    const snapshot = await fetchTokenSnapshot(ca);
    const value = snapshot && Number.isFinite(snapshot.price) && snapshot.price > 0
      ? {
          price: snapshot.price,
          liquidityUsd: Math.max(0, Number(snapshot.liq) || 0),
          mcapUsd: Math.max(0, Number(snapshot.mcap) || 0),
          source: 'dexscreener_recovery' as const,
          recoveredAt: Date.now(),
        }
      : null;

    if (value) {
      diag.successes++;
      diag.lastRecoveryAt = new Date(value.recoveredAt).toISOString();
      diag.lastRecoveryCa = ca;
    } else {
      diag.misses++;
      diag.lastMissAt = new Date().toISOString();
    }
    cache.set(ca, { expiresAt: Date.now() + CACHE_TTL_MS, value });
    if (cache.size > 2_000) {
      for (const [key, entry] of cache) {
        if (entry.expiresAt <= Date.now()) cache.delete(key);
        if (cache.size <= 1_500) break;
      }
    }
    return value;
  })();

  inFlight.set(ca, request);
  try {
    return await request;
  } finally {
    if (inFlight.get(ca) === request) inFlight.delete(ca);
  }
}

export function __resetTrackingRecoveryForTest() {
  cache.clear();
  inFlight.clear();
  Object.assign(diag, {
    attempts: 0,
    successes: 0,
    misses: 0,
    cacheHits: 0,
    deduped: 0,
    graceDeferrals: 0,
    trackingLostAfterGrace: 0,
    lastRecoveryAt: null,
    lastRecoveryCa: null,
    lastMissAt: null,
  });
}
