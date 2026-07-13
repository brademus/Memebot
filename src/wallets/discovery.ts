import { cfg, env } from '../config';
import { pool } from '../db';
import { earlyBuyers } from '../helius';
import { syncWebhook } from './webhook';
import { analyzeWallet } from './quality';

const VERDICT_RANK: Record<string, number> = { REJECT: 0, MARGINAL: 1, GOOD: 2, ELITE: 3 };
const meetsBar = (verdict: string) => VERDICT_RANK[verdict] >= (VERDICT_RANK[cfg().wallets.quality_min_verdict] ?? 1);
interface Diag { lastRun: string | null; lastError: string | null; winnersFound: number; walletsCredited: number; activeWallets: number; blockedBy: string | null }
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
  const settings = cfg().wallets;
  try {
    diag.lastRun = new Date().toISOString();
    diag.lastError = null;
    const winners = await pool.query(
      `SELECT DISTINCT t.ca,t.early_buyers FROM tokens t
       JOIN outcomes o ON o.ca=t.ca
       WHERE o.multiple_from_first >= $1
         AND t.first_seen > now()-interval '7 days'
         AND t.mined_at IS NULL LIMIT 25`,
      [settings.discovery_min_multiple]);
    diag.winnersFound = winners.rows.length;

    let credited = 0;
    for (const row of winners.rows) {
      const captured: string[] = row.early_buyers || [];
      const buyers = captured.length >= 3 ? captured : await earlyBuyers(row.ca, settings.early_buyer_slot_window);
      for (const wallet of buyers) {
        await pool.query(`INSERT INTO wallet_winners (wallet,ca) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [wallet, row.ca]);
        await pool.query(
          `INSERT INTO smart_wallets (wallet,type,winners_hit,discovered_from,active,last_validated)
           SELECT $1,'discovered',c.n,$2,c.n >= $3,now()
             FROM (SELECT COUNT(*)::int n FROM wallet_winners WHERE wallet=$1) c
           ON CONFLICT (wallet) DO UPDATE SET
             winners_hit=(SELECT COUNT(*)::int FROM wallet_winners WHERE wallet=$1),
             active=(SELECT COUNT(*)::int FROM wallet_winners WHERE wallet=$1) >= $3,
             last_validated=now()`,
          [wallet, row.ca, settings.wallet_min_winners]);
        credited++;
      }
      await pool.query(`UPDATE tokens SET mined_at=now() WHERE ca=$1`, [row.ca]);
    }
    diag.walletsCredited = credited;

    if (env.HELIUS_API_KEY && settings.quality_validation) {
      const toCheck = await pool.query(
        `SELECT wallet FROM smart_wallets
          WHERE active AND (quality_checked_at IS NULL OR quality_checked_at < now()-($1||' days')::interval)
          ORDER BY (last_active > now()-interval '24 hours') DESC,
                   quality_checked_at NULLS FIRST,winners_hit DESC LIMIT 30`,
        [String(settings.quality_recheck_days)]);
      for (const { wallet } of toCheck.rows) {
        const quality = await analyzeWallet(wallet);
        await pool.query(
          `UPDATE smart_wallets SET quality_verdict=$2,win_rate=$3,round_trips=$4,
             quality_checked_at=now(),active=active AND $5 WHERE wallet=$1`,
          [wallet, quality.verdict, +quality.winRate.toFixed(3), quality.roundTrips, meetsBar(quality.verdict)]);
      }
      if (settings.idle_deactivate_days > 0) {
        await pool.query(
          `UPDATE smart_wallets SET active=false
            WHERE active AND last_active IS NOT NULL
              AND last_active < now()-($1||' days')::interval`,
          [String(settings.idle_deactivate_days)]);
      }
    }

    if (env.HELIUS_API_KEY && settings.cobuyer_expansion) {
      const cobuyers = await pool.query(
        `WITH winner_buyers AS (
           SELECT DISTINCT t.ca,unnest(t.early_buyers) AS wallet
             FROM tokens t JOIN outcomes o ON o.ca=t.ca AND o.snapshot_minutes=240
            WHERE o.multiple_from_first >= $1 AND t.first_seen > now()-interval '14 days')
         SELECT wallet,COUNT(DISTINCT ca)::int shared FROM winner_buyers
          WHERE wallet NOT IN (SELECT wallet FROM smart_wallets)
          GROUP BY wallet HAVING COUNT(DISTINCT ca) >= $2
          ORDER BY 2 DESC LIMIT 20`,
        [settings.discovery_min_multiple, settings.cobuyer_min_shared]);
      for (const { wallet, shared } of cobuyers.rows) {
        const quality = await analyzeWallet(wallet);
        if (!meetsBar(quality.verdict)) continue;
        await pool.query(
          `INSERT INTO smart_wallets
             (wallet,type,winners_hit,discovered_from,active,last_validated,quality_verdict,win_rate,round_trips,quality_checked_at)
           VALUES ($1,'cobuyer',$2,'cobuyer_expansion',true,now(),$3,$4,$5,now())
           ON CONFLICT (wallet) DO NOTHING`,
          [wallet, shared, quality.verdict, +quality.winRate.toFixed(3), quality.roundTrips]);
      }
    }

    await pool.query(
      `UPDATE smart_wallets SET active=false WHERE active AND wallet NOT IN (
         SELECT wallet FROM smart_wallets WHERE active ORDER BY winners_hit DESC LIMIT $1)`,
      [settings.max_tracked_wallets]);

    // Judge copied entries from the wallet's own observed buy price and clock. The old
    // query used the bot's first-score price, which credited late buyers for earlier moves.
    const pruned = await pool.query(
      `UPDATE smart_wallets SET active=false WHERE wallet IN (
         SELECT w.wallet
           FROM smart_wallets w
           JOIN wallet_hit_outcomes o ON o.wallet=w.wallet AND o.snapshot_minutes=240
          WHERE w.active AND o.multiple_from_buy IS NOT NULL
          GROUP BY w.wallet
         HAVING COUNT(DISTINCT o.ca) >= $1
            AND (COUNT(DISTINCT o.ca) FILTER (WHERE o.multiple_from_buy >= 2))::float
                / COUNT(DISTINCT o.ca) < $2
       ) RETURNING wallet`,
      [settings.prune_min_measured_buys, settings.prune_max_2x_rate]);
    if (pruned.rowCount) console.log(`[wallets] pruned ${pruned.rowCount} wallets from wallet-entry outcomes`);

    const count = await pool.query(`SELECT COUNT(*)::int c FROM smart_wallets WHERE active`);
    diag.activeWallets = count.rows[0].c;
    console.log(`[wallets] discovery: ${diag.winnersFound} new winners, ${credited} credits, ${diag.activeWallets} active`);
    syncWebhook().catch(() => {});
  } catch (error) {
    diag.lastError = (error as Error).message;
    console.error('[wallets] discovery', diag.lastError);
  }
  return diag;
}
