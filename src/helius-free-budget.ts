// Durable daily Helius credit budget for the 1,000,000-credit free plan.
// Enhanced API requests (api.helius.xyz) are estimated at 100 credits; RPC at 1.
//
// HISTORY (2026-07-30): the first version was a 20,000-credit PER-PROCESS ceiling.
// Every Railway deploy reset it — five deploys in a day quintupled the real burn —
// while on stable days the whole allowance died in the first hours and Helius went
// dark for the rest (starving insider verification, the one proven edge). The
// budget is now persisted per-UTC-day in Postgres, survives deploys, and tracks
// estimated credits per caller category so the reports can NAME the top burner.
// Default 30,000/day ≈ 900k/month, safely under the plan. Tunable via
// HELIUS_DAILY_CREDITS. Fails open to a process-local ceiling when Postgres is
// unavailable (never silently unlimited).

import { pool } from './db';

const rawFetch = globalThis.fetch.bind(globalThis);
const DAILY_CREDITS = Math.max(5_000, Math.min(200_000, Number(process.env.HELIUS_DAILY_CREDITS || 30_000)));
const PROCESS_FALLBACK_CREDITS = 20_000;
const FLUSH_MS = 30_000;

let day = currentDay();
let estimatedCreditsToday = 0;
let persistedCredits = 0;
let blockedRequests = 0;
let loaded = false;
const byCategory: Record<string, number> = {};

function currentDay(): string { return new Date().toISOString().slice(0, 10); }

function isHelius(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'api.helius.xyz' || host.endsWith('.helius-rpc.com');
  } catch {
    return /helius\.xyz|helius-rpc\.com/i.test(url);
  }
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

/** Cost estimate + category label, so burn reports name the burner. */
export function classifyHeliusRequest(url: string): { cost: number; category: string } {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === 'api.helius.xyz') {
      if (/\/v0\/addresses\/.+\/transactions/.test(parsed.pathname)) return { cost: 100, category: 'enhanced_address_history' };
      if (/\/v0\/transactions/.test(parsed.pathname)) return { cost: 100, category: 'enhanced_tx_parse' };
      if (/webhook/i.test(parsed.pathname)) return { cost: 1, category: 'webhook_admin' };
      return { cost: 100, category: 'enhanced_other' };
    }
    return { cost: 1, category: 'rpc' };
  } catch {
    return /api\.helius\.xyz/i.test(url) ? { cost: 100, category: 'enhanced_other' } : { cost: 1, category: 'rpc' };
  }
}

async function ensureLoaded(): Promise<void> {
  if (loaded || !pool) return;
  loaded = true;
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS helius_daily_budget (
      day TEXT PRIMARY KEY, estimated_credits BIGINT NOT NULL DEFAULT 0, blocked_requests BIGINT NOT NULL DEFAULT 0)`);
    const existing = await pool.query(`SELECT estimated_credits, blocked_requests FROM helius_daily_budget WHERE day=$1`, [day]);
    if (existing.rows[0]) {
      estimatedCreditsToday = Number(existing.rows[0].estimated_credits) || 0;
      blockedRequests = Number(existing.rows[0].blocked_requests) || 0;
      persistedCredits = estimatedCreditsToday;
    }
  } catch { /* keep process-local accounting */ }
}

async function flush(): Promise<void> {
  if (!pool || estimatedCreditsToday === persistedCredits) return;
  try {
    await pool.query(`INSERT INTO helius_daily_budget (day, estimated_credits, blocked_requests)
      VALUES ($1,$2,$3)
      ON CONFLICT (day) DO UPDATE SET estimated_credits=$2, blocked_requests=$3`,
      [day, estimatedCreditsToday, blockedRequests]);
    persistedCredits = estimatedCreditsToday;
  } catch { /* retry next flush */ }
}
setInterval(() => { void flush(); }, FLUSH_MS).unref?.();

function rollDayIfNeeded(): void {
  const now = currentDay();
  if (now !== day) {
    day = now;
    estimatedCreditsToday = 0;
    persistedCredits = -1;   // force a flush row for the new day
    blockedRequests = 0;
    for (const key of Object.keys(byCategory)) delete byCategory[key];
  }
}

function budgetCeiling(): number { return pool ? DAILY_CREDITS : PROCESS_FALLBACK_CREDITS; }

function blockedResponse(): Response {
  return new Response(JSON.stringify({ error: 'helius daily credit budget reached' }), {
    status: 429,
    headers: {
      'content-type': 'application/json',
      'retry-after': '3600',
      'x-memebot-helius-budget-blocked': 'true',
    },
  });
}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = requestUrl(input);
  if (!isHelius(url)) return rawFetch(input as any, init);
  rollDayIfNeeded();
  void ensureLoaded();
  const { cost, category } = classifyHeliusRequest(url);
  if (estimatedCreditsToday + cost > budgetCeiling()) {
    blockedRequests++;
    return blockedResponse();
  }
  estimatedCreditsToday += cost;
  byCategory[category] = (byCategory[category] || 0) + cost;
  return rawFetch(input as any, init);
}) as typeof fetch;

export function heliusFreeBudgetDiag() {
  rollDayIfNeeded();
  return {
    enabled: true,
    day,
    dailyBudgetCredits: budgetCeiling(),
    persistent: !!pool,
    estimatedCreditsUsed: estimatedCreditsToday,
    estimatedCreditsRemaining: Math.max(0, budgetCeiling() - estimatedCreditsToday),
    blockedRequests,
    byCategory: { ...byCategory },
  };
}

(globalThis as any).__heliusFreeBudgetDiag = heliusFreeBudgetDiag;
console.log(`[helius-free-budget] durable daily budget: ${DAILY_CREDITS} estimated credits/day (persistent=${!!pool})`);
