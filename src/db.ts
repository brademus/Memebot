import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';
import { env } from './config';
import { TokenRecord } from './types';

export const pool = env.DATABASE_URL
  ? new Pool({ connectionString: env.DATABASE_URL, ssl: env.DATABASE_URL.includes('railway') ? { rejectUnauthorized: false } : undefined })
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
    `INSERT INTO tokens (ca, symbol, name, creator, source, first_seen, gate_result, gate_fail_reason, first_score_price, peak_score, last_state, last_score)
     VALUES ($1,$2,$3,$4,$5,to_timestamp($6/1000.0),$7,$8,$9,$10,$11,$12)
     ON CONFLICT (ca) DO UPDATE SET gate_result=$7, gate_fail_reason=$8, first_score_price=COALESCE(tokens.first_score_price,$9), peak_score=GREATEST(tokens.peak_score,$10), last_state=$11, last_score=$12`,
    [t.ca, t.symbol, t.name, t.creator, t.source, t.firstSeen,
     t.gated === null ? null : t.gated ? 'passed' : 'failed',
     t.gateFailReason, t.firstScorePrice, t.peakScore, t.state, t.score]
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
