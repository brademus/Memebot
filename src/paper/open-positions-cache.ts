import { pool } from '../db';
import { getToken } from '../store';

/**
 * Sync-readable cache of open TIMED-ENTRY position mints, refreshed from Postgres.
 * Exists so the PumpPortal guard can pin exact-event coverage for open positions
 * (the plan's Tier-1 subscription rule) from its synchronous hot path without a
 * query, without import cycles, and restart-safely. Research observations are
 * deliberately NOT pinned — they are the rotation fodder; only real positions
 * (a handful at any time) earn a pinned paid slot.
 */
const REFRESH_MS = 20_000;
const PIN_PRICE_FRESH_MS = 30 * 60_000;
const PIN_YOUNG_ENTRY_MS = 15 * 60_000;
const cache = new Map<string, number>();   // ca -> entry_at ms

/**
 * A pin is only deserved by a LIVELY position: its price was genuinely observed
 * recently, or it just entered and deserves a chance to produce its first trade.
 * Dead positions holding pins were starving live coins of paid exact-event slots
 * (observed 2026-07-28: ~50 zombie positions pinned against a 40-slot board).
 * Unpinning is immediate; the tracking-lost paperwork keeps its own clock.
 */
export function pinWorthy(entryAtMs: number | null, priceAtMs: number | null | undefined, now = Date.now()): boolean {
  if (entryAtMs && now - entryAtMs < PIN_YOUNG_ENTRY_MS) return true;
  return !!priceAtMs && now - priceAtMs < PIN_PRICE_FRESH_MS;
}
let timer: NodeJS.Timeout | null = null;
let lastRefreshAt: string | null = null;
let lastRefreshMs = 0;
let refreshErrors = 0;
let initialRefreshComplete = false;

async function refresh() {
  if (!pool) return;
  try {
    const result = await pool.query(
      `SELECT ca, EXTRACT(EPOCH FROM entry_at)*1000 AS entry_ms
         FROM paper_trades WHERE closed=false AND strategy_role='timed_entry'`,
    );
    cache.clear();
    for (const row of result.rows) if (row.ca) cache.set(String(row.ca), Number(row.entry_ms) || 0);
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

export const openTimedEntryCas = (): string[] => {
  const now = Date.now();
  return [...cache.entries()]
    .filter(([ca, entryMs]) => pinWorthy(entryMs || null, getToken(ca)?.priceAt ?? null, now))
    .map(([ca]) => ca);
};
export const openTimedEntryCasAll = (): string[] => [...cache.keys()];
export const openPositionsCacheDiag = () => ({ pinned: cache.size, lastRefreshAt, refreshErrors, initialRefreshComplete, cacheAgeSeconds: lastRefreshMs ? Math.round((Date.now() - lastRefreshMs) / 1000) : null });
export function __seedOpenPositionsForTest(cas: string[]) { cache.clear(); for (const ca of cas) cache.set(ca, Date.now()); }
