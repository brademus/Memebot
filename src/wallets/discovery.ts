import { cfg, env } from '../config';
import { pool } from '../db';
import { earlyBuyers } from '../helius';

// WALLET DISCOVERY — the proprietary edge.
// Runs hourly: finds tokens in our own outcomes DB that already 3x'd, walks back
// their earliest buyers, and credits each wallet. Wallets that appear early on
// multiple independent winners get promoted to the tracked smart-money list.
export function startWalletDiscovery() {
  if (!cfg().wallets.enabled || !env.HELIUS_API_KEY || !pool) return;
  setInterval(runDiscovery, 60 * 60_000);
  setTimeout(runDiscovery, 90_000);
}

async function runDiscovery() {
  if (!pool) return;
  const w = cfg().wallets;
  try {
    const winners = await pool.query(
      `SELECT DISTINCT t.ca FROM tokens t
       JOIN outcomes o ON o.ca = t.ca
       WHERE o.multiple_from_first >= $1
         AND t.first_seen > now() - interval '7 days'
       LIMIT 25`, [w.discovery_min_multiple]);

    for (const row of winners.rows) {
      const buyers = await earlyBuyers(row.ca, w.early_buyer_slot_window);
      for (const wallet of buyers) {
        await pool.query(
          `INSERT INTO smart_wallets (wallet, type, winners_hit, discovered_from, active, last_validated)
           VALUES ($1, 'discovered', 1, $2, false, now())
           ON CONFLICT (wallet) DO UPDATE
             SET winners_hit = smart_wallets.winners_hit + 1,
                 active = (smart_wallets.winners_hit + 1 >= $3),
                 last_validated = now()`,
          [wallet, row.ca, w.wallet_min_winners]);
      }
    }
    await pool.query(
      `UPDATE smart_wallets SET active = false
       WHERE wallet NOT IN (
         SELECT wallet FROM smart_wallets WHERE active ORDER BY winners_hit DESC LIMIT $1)`,
      [w.max_tracked_wallets]);

    const n = await pool.query(`SELECT COUNT(*)::int c FROM smart_wallets WHERE active`);
    console.log(`[wallets] discovery pass done — ${n.rows[0].c} active tracked wallets`);
  } catch (e) { console.error('[wallets] discovery', (e as Error).message); }
}
