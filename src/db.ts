import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';
import { env } from './config';
import { TokenRecord } from './types';

// SSL: Railway's internal hostnames (*.railway.internal) speak plain TCP — forcing SSL
// there breaks the connection. Public proxy URLs accept TLS. Detect by hostname.
function sslFor(url: string) {
  try {
    const host = new URL(url).hostname;
    if (host.endsWith('.railway.internal') || host === 'localhost') return undefined;
    return { rejectUnauthorized: false };
  } catch { return undefined; }
}
export const pool = env.DATABASE_URL
  ? new Pool({ connectionString: env.DATABASE_URL, ssl: sslFor(env.DATABASE_URL) })
  : null;

export async function initDb() {
  if (!pool) { console.warn('[db] no DATABASE_URL — running memory-only (outcomes will NOT be logged)'); return; }
  const schema = fs.readFileSync(path.join(process.cwd(), 'schema.sql'), 'utf8');
  await pool.query(schema);
  console.log('[db] schema ready');
}

export async function upsertToken(t: TokenRecord) {
  if (!pool) return;
  await pool.query(
    `INSERT INTO tokens (ca, symbol, name, creator, source, first_seen, gate_result, gate_fail_reason, first_score_price, peak_score, last_state, last_score, subs, insider_pct, early_buyers)
     VALUES ($1,$2,$3,$4,$5,to_timestamp($6/1000.0),$7,$8,$9,$10,$11,$12,$13,$14,$15::text[])
     ON CONFLICT (ca) DO UPDATE SET gate_result=$7, gate_fail_reason=$8, first_score_price=COALESCE(tokens.first_score_price,$9), peak_score=GREATEST(tokens.peak_score,$10), last_state=$11, last_score=$12, subs=COALESCE($13, tokens.subs), insider_pct=COALESCE($14, tokens.insider_pct), early_buyers=CASE WHEN cardinality($15::text[]) > 0 THEN $15::text[] ELSE tokens.early_buyers END`,
    [t.ca, t.symbol, t.name, t.creator, t.source, t.firstSeen,
     t.gated === null ? null : t.gated ? 'passed' : 'failed',
     t.gateFailReason, t.firstScorePrice, t.peakScore, t.state, t.score,
     t.gated === true ? JSON.stringify(t.subs) : null,
     t.bundle ? t.bundle.insiderPct : null,
     t.earlyBuyers || []]
  ).catch(e => console.error('[db] upsert', e.message));
}

export async function logOutcome(ca: string, minutes: number, price: number, liq: number, mcap: number, firstPrice: number | null) {
  if (!pool) return;
  await pool.query(
    `INSERT INTO outcomes (ca, snapshot_minutes, price_usd, liquidity_usd, mcap_usd, multiple_from_first)
     VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (ca, snapshot_minutes) DO NOTHING`,
    [ca, minutes, price, liq, mcap, firstPrice ? price / firstPrice : null]
  ).catch(e => console.error('[db] outcome', e.message));
}

export async function bumpDeployer(wallet: string) {
  if (!pool || !wallet) return;
  await pool.query(
    `INSERT INTO deployers (wallet) VALUES ($1)
     ON CONFLICT (wallet) DO UPDATE SET tokens_launched = deployers.tokens_launched + 1, last_seen = now()`,
    [wallet]
  ).catch(() => {});
}

export async function isBlacklistedDeployer(wallet: string): Promise<boolean> {
  if (!pool || !wallet) return false;
  const r = await pool.query(`SELECT blacklisted FROM deployers WHERE wallet=$1`, [wallet]).catch(() => null);
  return !!r?.rows[0]?.blacklisted;
}

export async function markRug(ca: string) {
  if (!pool) return;
  // called by outcome logger when a token round-trips to ~zero: increment deployer rug count, auto-blacklist at 2+
  await pool.query(
    `UPDATE deployers d SET rugs = rugs + 1, blacklisted = (rugs + 1 >= 2)
     FROM tokens t WHERE t.ca = $1 AND d.wallet = t.creator`,
    [ca]
  ).catch(() => {});
}

export interface HistoryRow {
  ca: string; symbol: string; source: string; first_seen: string;
  gate_result: string | null; gate_fail_reason: string | null;
  last_state: string | null; last_score: number | null;
  multiple_4h: number | null;
}
export async function fetchHistory(before: string | null, limit: number): Promise<HistoryRow[]> {
  if (!pool) return [];
  const r = await pool.query(
    `SELECT t.ca, t.symbol, t.source, t.first_seen, t.gate_result, t.gate_fail_reason,
            t.last_state, t.last_score, o.multiple_from_first AS multiple_4h
     FROM tokens t LEFT JOIN outcomes o ON o.ca = t.ca AND o.snapshot_minutes = 240
     WHERE ($1::timestamptz IS NULL OR t.first_seen < $1)
     ORDER BY t.first_seen DESC LIMIT $2`,
    [before, Math.min(limit, 200)]).catch(() => null);
  return r ? r.rows : [];
}
export async function addSmartWallet(wallet: string, type: string) {
  if (!pool) throw new Error('no database');
  await pool.query(
    `INSERT INTO smart_wallets (wallet, type, active, last_validated) VALUES ($1,$2,TRUE,now())
     ON CONFLICT (wallet) DO UPDATE SET active=TRUE, type=$2`, [wallet, type]);
}
export async function removeSmartWallet(wallet: string) {
  if (!pool) throw new Error('no database');
  await pool.query(`UPDATE smart_wallets SET active=FALSE WHERE wallet=$1`, [wallet]);
}
export async function listSmartWallets() {
  if (!pool) return [];
  const r = await pool.query(`SELECT wallet, type, active, last_validated FROM smart_wallets ORDER BY last_validated DESC`).catch(() => null);
  return r ? r.rows : [];
}

export async function markTrigger(ca: string, price: number) {
  if (!pool) return;
  await pool.query(
    `UPDATE tokens SET triggered_at = COALESCE(triggered_at, now()), trigger_price = COALESCE(trigger_price, $2) WHERE ca = $1`,
    [ca, price]
  ).catch(() => {});
}
