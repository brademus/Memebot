import { cfg, env } from '../config';
import { pool } from '../db';
import { earlyBuyers } from '../helius';
import { syncWebhook } from './webhook';
import { analyzeWallet } from './quality';

const VERDICT_RANK: Record<string, number> = { REJECT: 0, MARGINAL: 1, GOOD: 2, ELITE: 3 };
const meetsBar = (v: string) => VERDICT_RANK[v] >= (VERDICT_RANK[cfg().wallets.quality_min_verdict] ?? 1);

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

    // ---- QUALITY VALIDATION: judge candidates on their OWN record ----
    // Overlap with one of our winners earns a look, not a slot. Analyze each
    // unvalidated active wallet's independent Helius P&L; demote those that don't
    // clear the quality bar even if their winners_hit count is high (one lucky
    // early buy on our winner ≠ a good trader).
    if (env.HELIUS_API_KEY && cfg().wallets.quality_validation) {
      const recheck = cfg().wallets.quality_recheck_days;
      const toCheck = await pool.query(
        `SELECT wallet FROM smart_wallets
         WHERE active AND (quality_checked_at IS NULL OR quality_checked_at < now() - ($1 || ' days')::interval)
         ORDER BY (last_active > now() - interval '24 hours') DESC,  -- vet active wallets first
                  quality_checked_at NULLS FIRST, winners_hit DESC LIMIT 30`, [String(recheck)]);
      for (const { wallet } of toCheck.rows) {
        const q = await analyzeWallet(wallet);
        await pool.query(
          `UPDATE smart_wallets SET quality_verdict=$2, win_rate=$3, round_trips=$4,
             quality_checked_at=now(), active = active AND $5
           WHERE wallet=$1`,
          [wallet, q.verdict, +q.winRate.toFixed(3), q.roundTrips, meetsBar(q.verdict)]);
        if (!meetsBar(q.verdict))
          console.log(`[wallets] demoted ${wallet.slice(0, 6)} — quality ${q.verdict} (${q.roundTrips} round-trips, ${(q.winRate * 100).toFixed(0)}% win)`);
      }
      // IDLE DEMOTION: a proven wallet that has gone silent for the cutoff is not a
      // copy-trade target anymore. Deactivate wallets with no activity in the window
      // (they stay in the DB and re-activate if they start trading again via the
      // webhook stamp). Keeps the tracked set to wallets actually moving NOW.
      const idleDays = cfg().wallets.idle_deactivate_days;
      if (idleDays > 0) {
        const demoted = await pool.query(
          `UPDATE smart_wallets SET active = false
           WHERE active AND last_active IS NOT NULL AND last_active < now() - ($1 || ' days')::interval
           RETURNING wallet`, [String(idleDays)]);
        if (demoted.rowCount) console.log(`[wallets] deactivated ${demoted.rowCount} idle wallets (>${idleDays}d silent)`);
      }
    }

    // ---- CO-BUYER EXPANSION: escape the self-winner blind spot ----
    // Wallets in the early-buyer cohort of MULTIPLE distinct winners that haven't
    // earned a slot yet. Mines `early_buyers` (captured per winner, mostly UNtracked
    // wallets) — NOT wallet_hits, which only holds tracked wallets and would just
    // re-find ourselves. (Scope note: early_buyers is the first-15 cohort, so this
    // widens toward recurring early snipers of winners; a wallet recurring across
    // 2+ winners is a strong lead, and its own record then decides.)
    if (env.HELIUS_API_KEY && cfg().wallets.cobuyer_expansion) {
      const shared = cfg().wallets.cobuyer_min_shared;
      const cobuyers = await pool.query(
        `WITH winner_buyers AS (
           SELECT DISTINCT t.ca, unnest(t.early_buyers) AS wallet
           FROM tokens t JOIN outcomes o ON o.ca = t.ca AND o.snapshot_minutes = 240
           WHERE o.multiple_from_first >= $1 AND t.first_seen > now() - interval '14 days'
         )
         SELECT wallet, COUNT(DISTINCT ca)::int shared
         FROM winner_buyers
         WHERE wallet NOT IN (SELECT wallet FROM smart_wallets)
         GROUP BY wallet HAVING COUNT(DISTINCT ca) >= $2
         ORDER BY 2 DESC LIMIT 20`, [w.discovery_min_multiple, shared]);
      for (const { wallet, shared: sh } of cobuyers.rows) {
        const q = await analyzeWallet(wallet);
        if (!meetsBar(q.verdict)) continue;   // co-occurrence is a lead; the record decides
        await pool.query(
          `INSERT INTO smart_wallets (wallet, type, winners_hit, discovered_from, active, last_validated, quality_verdict, win_rate, round_trips, quality_checked_at)
           VALUES ($1, 'cobuyer', $2, 'cobuyer_expansion', true, now(), $3, $4, $5, now())
           ON CONFLICT (wallet) DO NOTHING`,
          [wallet, sh, q.verdict, +q.winRate.toFixed(3), q.roundTrips]);
        console.log(`[wallets] +co-buyer ${wallet.slice(0, 6)} — shared ${sh} winners, own record ${q.verdict} (${(q.winRate * 100).toFixed(0)}% win)`);
      }
    }

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
