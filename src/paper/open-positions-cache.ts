import { pool } from '../db';

/**
 * Sync-readable cache of open TIMED-ENTRY position mints, refreshed from Postgres.
 * Exists so the PumpPortal guard can pin exact-event coverage for open positions
 * (the plan's Tier-1 subscription rule) from its synchronous hot path without a
 * query, without import cycles, and restart-safely. Research observations are
 * deliberately NOT pinned — they are the rotation fodder; only real positions
 * (a handful at any time) earn a pinned paid slot.
 */
const REFRESH_MS = 20_000;
const cache = new Set<string>();
let timer: NodeJS.Timeout | null = null;
let lastRefreshAt: string | null = null;
let lastRefreshMs = 0;
let refreshErrors = 0;
let initialRefreshComplete = false;

async function refresh() {
  if (!pool) return;
  try {
    const result = await pool.query(
      `SELECT ca FROM paper_trades WHERE closed=false AND strategy_role='timed_entry'`,
    );
    cache.clear();
    for (const row of result.rows) if (row.ca) cache.add(String(row.ca));
    lastRefreshAt = new Date().toISOString();
    lastRefreshMs = Date.now();
    initialRefreshComplete = true;
  } catch { refreshErrors++; }
}

export function startOpenPositionsCache(): Promise<void> {
  if (timer) return Promise.resolve();
  const first = refresh();   // awaited by boot so the guard never starts pin-blind
  timer = setInterval(() => void refresh(), REFRESH_MS);
  timer.unref();
  return first;
}

export const openTimedEntryCas = (): string[] => [...cache];
export const openPositionsCacheDiag = () => ({ pinned: cache.size, lastRefreshAt, refreshErrors, initialRefreshComplete, cacheAgeSeconds: lastRefreshMs ? Math.round((Date.now() - lastRefreshMs) / 1000) : null });
export function __seedOpenPositionsForTest(cas: string[]) { cache.clear(); for (const ca of cas) cache.add(ca); }
