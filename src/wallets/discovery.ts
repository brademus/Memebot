import { cfg, env } from '../config';
import { pool } from '../db';
import { earlyBuyers } from '../helius';
import { syncWebhook } from './webhook';

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
      `SELECT DISTINCT t.ca, t.early_buyers FROM tokens t
       JOIN outcomes o ON o.ca = t.ca
       WHERE o.multiple_from_first >= $1
         AND t.first_seen > now() - interval '7 days'
         AND t.mined_at IS NULL
       LIMIT 25`, [w.discovery_min_multiple]);
    diag.winnersFound = winners.rows.length;

    let credited = 0;
    for (const row of winners.rows) {
      // primary source: the EXACT first-15 buyers we captured live off the trade
      // stream — precise and free. Helius reconstruction only for pre-stream tokens.
      const captured: string[] = row.early_buyers || [];
      const buyers = captured.length >= 3
        ? captured
        : await earlyBuyers(row.ca, w.early_buyer_slot_window);
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

    // PRUNE PROVEN LOSERS: a wallet earned its slot from past winners, but slots
    // are for wallets that are STILL good. Enough measured buys to judge + almost
    // no 2x hits = deactivated, freeing capacity for fresher discoveries.
    // Denominator is measured outcomes only, so fresh buys never count against it.
    const pruned = await pool.query(
      `UPDATE smart_wallets SET active = false WHERE wallet IN (
         SELECT w2.wallet
         FROM smart_wallets w2
         JOIN wallet_hits h ON h.wallet = w2.wallet
         JOIN outcomes o ON o.ca = h.ca AND o.snapshot_minutes = 240
         WHERE w2.active
         GROUP BY w2.wallet
         HAVING COUNT(DISTINCT h.ca) >= $1
            AND (COUNT(DISTINCT h.ca) FILTER (WHERE o.multiple_from_first >= 2))::float
                / COUNT(DISTINCT h.ca) < $2
       ) RETURNING wallet`,
      [w.prune_min_measured_buys, w.prune_max_2x_rate]);
    if (pruned.rowCount) console.log(`[wallets] pruned ${pruned.rowCount} cold wallets (>=${w.prune_min_measured_buys} measured buys, <${w.prune_max_2x_rate * 100}% 2x rate)`);

    const n = await pool.query(`SELECT COUNT(*)::int c FROM smart_wallets WHERE active`);
    diag.activeWallets = n.rows[0].c;
    console.log(`[wallets] discovery: ${diag.winnersFound} new winners mined, ${credited} wallet credits, ${diag.activeWallets} active`);
    syncWebhook().catch(() => {});   // newly credited wallets start streaming now, not next cycle
  } catch (e) {
    diag.lastError = (e as Error).message;
    console.error('[wallets] discovery', diag.lastError);
  }
  return diag;
}
