// Durable daily Helius credit budget for the free-plan credit allowance.
// Enhanced API requests (api.helius.xyz) are estimated at 100 credits; RPC at 1.
//
// HISTORY (2026-07-30, part 1): the first version was a 20,000-credit
// PER-PROCESS ceiling. Every Railway deploy reset it, while stable days died in
// the first hours and went dark for the rest. Replaced with a durable
// per-UTC-day budget in Postgres.
//
// HISTORY (2026-07-30, part 2): that durable budget used ONE shared ceiling for
// EVERY Helius call. A leak in the expensive enhanced category (the trade
// backfill firehose, since throttled separately) spent the whole shared pool
// before the fix landed — and because the pool was shared, it ALSO blocked
// every cheap 1-credit RPC call for the rest of the day. bundle.ts and
// deployer.ts (insider/bundle detection — the one proven edge) both fail OPEN
// on a Helius error (return pass:true), so an exhausted shared budget didn't
// just pause enrichment, it silently made every token look clean until UTC
// midnight. The two categories are now tracked and capped SEPARATELY: a
// generous RPC ceiling that should never bind under normal operation (RPC
// powers whatever needs live on-chain reads and must not go dark just because
// an expensive, already-throttled category burned its own allowance), and the
// existing enhanced ceiling that remains the real guard against a runaway
// 100-credit-per-call category. Exhausting one never silences the other.
//
// Fails open to process-local ceilings when Postgres is unavailable (never
// silently unlimited).

import { pool } from './db';

const rawFetch = globalThis.fetch.bind(globalThis);
const ENHANCED_DAILY_CREDITS = Math.max(5_000, Math.min(200_000, Number(process.env.HELIUS_DAILY_CREDITS || 30_000)));
// Deliberately generous: RPC is ~1/100th the cost of an enhanced call and backs
// insider/bundle detection, which fails OPEN on error. Starving RPC is worse
// than not metering it much at all; this ceiling exists as a backstop against a
// genuinely runaway RPC loop, not as an expected day-to-day constraint.
const RPC_DAILY_CREDITS = Math.max(5_000, Math.min(500_000, Number(process.env.HELIUS_DAILY_RPC_CREDITS || 50_000)));
const PROCESS_FALLBACK_ENHANCED_CREDITS = 20_000;
const PROCESS_FALLBACK_RPC_CREDITS = 20_000;
const FLUSH_MS = 30_000;

let day = currentDay();
let estimatedCreditsToday = 0;   // combined total, kept for back-compat display
let persistedCredits = 0;
let persistedByCategory = '{}';
let blockedRequests = 0;
let blockedEnhancedRequests = 0;
let blockedRpcRequests = 0;
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

const rpcUsed = () => byCategory['rpc'] || 0;
const enhancedUsed = () => estimatedCreditsToday - rpcUsed();
const enhancedCeiling = () => (pool ? ENHANCED_DAILY_CREDITS : PROCESS_FALLBACK_ENHANCED_CREDITS);
const rpcCeiling = () => (pool ? RPC_DAILY_CREDITS : PROCESS_FALLBACK_RPC_CREDITS);

/**
 * The actual fix, isolated as a pure function: each category is checked against
 * ITS OWN ceiling and ITS OWN running total, so exhausting one can never block
 * the other. Before this split, one shared pool meant a leak in the expensive
 * enhanced category silenced cheap RPC too — and RPC backs bundle/deployer
 * insider detection, which fails OPEN on error, so a blocked RPC call didn't
 * pause enrichment, it silently made every token look clean.
 */
export function decideHeliusRequest(
  category: string,
  cost: number,
  rpcUsedSoFar: number,
  enhancedUsedSoFar: number,
  rpcCeilingValue: number,
  enhancedCeilingValue: number,
): { allowed: boolean; scope: 'enhanced' | 'rpc' } {
  const isRpc = category === 'rpc';
  const soFar = isRpc ? rpcUsedSoFar : enhancedUsedSoFar;
  const ceiling = isRpc ? rpcCeilingValue : enhancedCeilingValue;
  return { allowed: soFar + cost <= ceiling, scope: isRpc ? 'rpc' : 'enhanced' };
}

async function ensureLoaded(): Promise<void> {
  if (loaded || !pool) return;
  loaded = true;
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS helius_daily_budget (
      day TEXT PRIMARY KEY, estimated_credits BIGINT NOT NULL DEFAULT 0,
      blocked_requests BIGINT NOT NULL DEFAULT 0,
      blocked_enhanced_requests BIGINT NOT NULL DEFAULT 0,
      blocked_rpc_requests BIGINT NOT NULL DEFAULT 0,
      by_category JSONB NOT NULL DEFAULT '{}'::jsonb)`);
    await pool.query(`ALTER TABLE helius_daily_budget ADD COLUMN IF NOT EXISTS blocked_enhanced_requests BIGINT NOT NULL DEFAULT 0`);
    await pool.query(`ALTER TABLE helius_daily_budget ADD COLUMN IF NOT EXISTS blocked_rpc_requests BIGINT NOT NULL DEFAULT 0`);
    await pool.query(`ALTER TABLE helius_daily_budget ADD COLUMN IF NOT EXISTS by_category JSONB NOT NULL DEFAULT '{}'::jsonb`);
    const existing = await pool.query(
      `SELECT estimated_credits, blocked_requests, blocked_enhanced_requests, blocked_rpc_requests, by_category
         FROM helius_daily_budget WHERE day=$1`, [day]);
    if (existing.rows[0]) {
      estimatedCreditsToday = Number(existing.rows[0].estimated_credits) || 0;
      blockedRequests = Number(existing.rows[0].blocked_requests) || 0;
      blockedEnhancedRequests = Number(existing.rows[0].blocked_enhanced_requests) || 0;
      blockedRpcRequests = Number(existing.rows[0].blocked_rpc_requests) || 0;
      const restored = existing.rows[0].by_category || {};
      for (const [key, value] of Object.entries(restored)) byCategory[key] = Number(value) || 0;
      persistedCredits = estimatedCreditsToday;
      persistedByCategory = JSON.stringify(byCategory);
    }
  } catch { /* keep process-local accounting */ }
}

async function flush(): Promise<void> {
  if (!pool) return;
  const currentByCategoryJson = JSON.stringify(byCategory);
  if (estimatedCreditsToday === persistedCredits && currentByCategoryJson === persistedByCategory) return;
  try {
    await pool.query(`INSERT INTO helius_daily_budget (day, estimated_credits, blocked_requests, blocked_enhanced_requests, blocked_rpc_requests, by_category)
      VALUES ($1,$2,$3,$4,$5,$6::jsonb)
      ON CONFLICT (day) DO UPDATE SET estimated_credits=$2, blocked_requests=$3, blocked_enhanced_requests=$4, blocked_rpc_requests=$5, by_category=$6::jsonb`,
      [day, estimatedCreditsToday, blockedRequests, blockedEnhancedRequests, blockedRpcRequests, currentByCategoryJson]);
    persistedCredits = estimatedCreditsToday;
    persistedByCategory = currentByCategoryJson;
  } catch { /* retry next flush */ }
}
setInterval(() => { void flush(); }, FLUSH_MS).unref?.();

function rollDayIfNeeded(): void {
  const now = currentDay();
  if (now !== day) {
    day = now;
    estimatedCreditsToday = 0;
    persistedCredits = -1;
    persistedByCategory = '\u0000';   // force a flush row for the new day
    blockedRequests = 0;
    blockedEnhancedRequests = 0;
    blockedRpcRequests = 0;
    for (const key of Object.keys(byCategory)) delete byCategory[key];
  }
}

function blockedResponse(scope: 'enhanced' | 'rpc'): Response {
  return new Response(JSON.stringify({ error: `helius daily ${scope} credit budget reached` }), {
    status: 429,
    headers: {
      'content-type': 'application/json',
      'retry-after': '3600',
      'x-memebot-helius-budget-blocked': scope,
    },
  });
}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = requestUrl(input);
  if (!isHelius(url)) return rawFetch(input as any, init);
  rollDayIfNeeded();
  void ensureLoaded();
  const { cost, category } = classifyHeliusRequest(url);
  const decision = decideHeliusRequest(category, cost, rpcUsed(), enhancedUsed(), rpcCeiling(), enhancedCeiling());
  if (!decision.allowed) {
    blockedRequests++;
    if (decision.scope === 'rpc') blockedRpcRequests++; else blockedEnhancedRequests++;
    return blockedResponse(decision.scope);
  }
  estimatedCreditsToday += cost;
  byCategory[category] = (byCategory[category] || 0) + cost;
  return rawFetch(input as any, init);
}) as typeof fetch;

export function heliusFreeBudgetDiag() {
  rollDayIfNeeded();
  const rpc = rpcUsed();
  const enhanced = enhancedUsed();
  return {
    enabled: true,
    day,
    persistent: !!pool,
    dailyBudgetCredits: enhancedCeiling(),                 // back-compat name: the enhanced ceiling
    dailyRpcBudgetCredits: rpcCeiling(),
    estimatedCreditsUsed: estimatedCreditsToday,            // back-compat: combined total
    estimatedEnhancedCreditsUsed: enhanced,
    estimatedRpcCreditsUsed: rpc,
    estimatedCreditsRemaining: Math.max(0, enhancedCeiling() - enhanced),   // back-compat: enhanced remaining
    estimatedRpcCreditsRemaining: Math.max(0, rpcCeiling() - rpc),
    blockedRequests,
    blockedEnhancedRequests,
    blockedRpcRequests,
    byCategory: { ...byCategory },
  };
}

(globalThis as any).__heliusFreeBudgetDiag = heliusFreeBudgetDiag;
console.log(`[helius-free-budget] durable split budget: enhanced=${ENHANCED_DAILY_CREDITS}/day, rpc=${RPC_DAILY_CREDITS}/day (persistent=${!!pool})`);
