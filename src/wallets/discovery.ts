import { cfg, env } from '../config';
import { pool } from '../db';
import { earlyBuyers } from '../helius';

// WALLET DISCOVERY v2.
// Fixes from v1: (a) winners were re-mined EVERY hour with no processed-marker, so a
// wallet from ONE winner got its count inflated each pass — winners_hit now counts
// DISTINCT winning tokens via the wallet_winners pair table, and mined tokens are
// marked; (b) full diagnostics exposed so "why are there no wallets" is answerable
// from the dashboard instead of guesswork.

interface Diag {
  lastRun: string | null;
  lastError: string | null;
  winnersFound: number;
  walletsCredited: number;
  activeWallets: number;
  blockedBy: string | null;
}
const diag: Diag = { lastRun: null, lastError: null, winnersFound: 0, walletsCredited: 0, activeWallets: 0, blockedBy: null };
export const discoveryDiag = () => diag;

export function startWalletDiscovery() {
  if (!cfg().wallets.enabled) { diag.blockedBy = 'wallets.enabled=false in config'; return; }
  if (!env.HELIUS_API_KEY) { diag.blockedBy = 'HELIUS_API_KEY not set'; return; }
  if (!pool) { diag.blockedBy = 'no database'; return; }
  diag.blockedBy = null;
  setInterval(runDiscovery, 60 * 60_000);
  setTimeout(runDiscovery, 90_000);
}

export async function runDiscovery(): Promise<Diag> {
  if (!pool) { diag.blockedBy = 'no database'; return diag; }
  const w = cfg().wallets;
  try {
    diag.lastRun = new Date().toISOString();
    diag.lastError = null;

    // unmined winners only
    const winners = await pool.query(
      `SELECT DISTINCT t.ca FROM tokens t
       JOIN outcomes o ON o.ca = t.ca
       WHERE o.multiple_from_first >= $1
         AND t.first_seen > now() - interval '7 days'
         AND t.mined_at IS NULL
       LIMIT 25`, [w.discovery_min_multiple]);
    diag.winnersFound = winners.rows.length;

    let credited = 0;
    for (const row of winners.rows) {
      const buyers = await earlyBuyers(row.ca, w.early_buyer_slot_window);
      for (const wallet of buyers) {
        await pool.query(
          `INSERT INTO wallet_winners (wallet, ca) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [wallet, row.ca]);
        // winners_hit = distinct winning tokens this wallet bought early
        await pool.query(
          `INSERT INTO smart_wallets (wallet, type, winners_hit, discovered_from, active, last_validated)
           SELECT $1, 'discovered', c.n, $2, c.n >= $3, now()
           FROM (SELECT COUNT(*)::int n FROM wallet_winners WHERE wallet = $1) c
           ON CONFLICT (wallet) DO UPDATE SET
             winners_hit = (SELECT COUNT(*)::int FROM wallet_winners WHERE wallet = $1),
             active = (SELECT COUNT(*)::int FROM wallet_winners WHERE wallet = $1) >= $3,
             last_validated = now()`,
          [wallet, row.ca, w.wallet_min_winners]);
        credited++;
      }
      await pool.query(`UPDATE tokens SET mined_at = now() WHERE ca = $1`, [row.ca]);
    }
    diag.walletsCredited = credited;

    await pool.query(
      `UPDATE smart_wallets SET active = false
       WHERE active AND wallet NOT IN (
         SELECT wallet FROM smart_wallets WHERE active ORDER BY winners_hit DESC LIMIT $1)`,
      [w.max_tracked_wallets]);

    const n = await pool.query(`SELECT COUNT(*)::int c FROM smart_wallets WHERE active`);
    diag.activeWallets = n.rows[0].c;
    console.log(`[wallets] discovery: ${diag.winnersFound} new winners mined, ${credited} wallet credits, ${diag.activeWallets} active`);
  } catch (e) {
    diag.lastError = (e as Error).message;
    console.error('[wallets] discovery', diag.lastError);
  }
  return diag;
}
