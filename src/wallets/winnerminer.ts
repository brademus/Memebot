import { cfg, env } from '../config';
import { pool } from '../db';
import { earlyBuyers } from '../helius';
import { analyzeWallet } from './quality';
import { syncWebhook } from './webhook';

// WINNER-WALLET MINING — "find the best memecoin traders and track them," done
// EMPIRICALLY instead of from a curated list of famous names.
//
// Why not a hardcoded list of known traders: the famous pump.fun wallets are (a)
// already so copy-traded their edge is arbitraged the instant they buy, and (b)
// often adversarial — decoy wallets and bait buys that trap copy-traders into
// their exits. Fame != profitability. A list of Twitter-famous names is strictly
// worse than judging wallets by their actual on-chain P&L.
//
// What the market gives us for free: the biggest movers of the day. The wallets
// that bought $W26 (90x) or $mogdog (89x) EARLY are proven good by the outcome —
// not a guess. So: take big external winners (GeckoTerminal top movers), pull
// their early buyers, run each through the quality analyzer (independent P&L), and
// track only the ones that clear the bar. The market nominates; the analyzer
// confirms; nothing is trusted on reputation.

const GT = 'https://api.geckoterminal.com/api/v2/networks/solana';

const diag = { lastRun: null as string | null, lastError: null as string | null, moversScanned: 0, candidatesfound: 0, tracked: 0 };
export const winnerMinerDiag = () => ({ ...diag });

export function startWinnerWalletMiner() {
  if (!pool || !env.HELIUS_API_KEY || !cfg().wallets.winner_mining_enabled) return;
  const tick = () => run().catch(e => { diag.lastError = (e as Error).message; });
  setTimeout(tick, 6 * 60_000);                       // 6min after boot
  setInterval(tick, Math.max(1, cfg().wallets.winner_mining_hours) * 3600_000);
}

async function run() {
  if (!pool) return;
  const w = cfg().wallets;
  diag.lastRun = new Date().toISOString();
  diag.lastError = null;

  // 1. the market's biggest movers right now — proven winners, whoever made them
  const movers: { ca: string; chg: number }[] = [];
  for (const path of ['/pools?sort=h24_volume_usd_desc', '/trending_pools']) {
    try {
      const res = await fetch(`${GT}${path}`, { headers: { accept: 'application/json' } });
      if (!res.ok) continue;
      const data: any = await res.json();
      for (const p of data.data || []) {
        const ca = (p.relationships?.base_token?.data?.id || '').replace(/^solana_/, '');
        const chg = Number(p.attributes?.price_change_percentage?.h24) || 0;
        if (ca && chg >= w.winner_mining_min_pct) movers.push({ ca, chg });
      }
    } catch { /* best effort */ }
  }
  diag.moversScanned = movers.length;
  if (!movers.length) return;

  // 2. for each mover, who bought EARLY (candidate smart traders), skipping
  //    wallets we already track. Cap the mint fan-out to protect Helius budget.
  const candidates = new Map<string, number>();   // wallet -> best mover % they were early on
  const tracked = new Set((await pool.query(`SELECT wallet FROM smart_wallets`).catch(() => ({ rows: [] as any[] }))).rows.map((r: any) => r.wallet));
  for (const m of movers.slice(0, w.winner_mining_max_mints)) {
    const buyers = await earlyBuyers(m.ca, 3).catch(() => [] as string[]);
    for (const b of buyers) {
      if (tracked.has(b)) continue;
      candidates.set(b, Math.max(candidates.get(b) || 0, m.chg));
    }
  }
  diag.candidatesfound = candidates.size;

  // 3. vet each candidate on its OWN record — the market nominated them, the
  //    analyzer decides. Only wallets clearing the quality bar get tracked.
  let added = 0;
  const ranked = [...candidates.entries()].sort((a, b) => b[1] - a[1]).slice(0, w.winner_mining_max_vet);
  for (const [wallet, moverPct] of ranked) {
    const q = await analyzeWallet(wallet);
    if (q.verdict === 'REJECT' || q.verdict === 'MARGINAL') continue;   // only GOOD/ELITE from cold discovery
    await pool.query(
      `INSERT INTO smart_wallets (wallet, type, winners_hit, discovered_from, active, last_validated, quality_verdict, win_rate, round_trips, quality_checked_at)
       VALUES ($1, 'winner_miner', 1, 'winner_mining', true, now(), $2, $3, $4, now())
       ON CONFLICT (wallet) DO NOTHING`,
      [wallet, q.verdict, +q.winRate.toFixed(3), q.roundTrips]);
    added++;
    console.log(`[winner-miner] +${wallet.slice(0, 6)} — early on a +${Math.round(moverPct)}% mover, own record ${q.verdict} (${(q.winRate * 100).toFixed(0)}% win, ${q.roundTrips} round-trips)`);
  }
  diag.tracked = added;
  if (added > 0) { syncWebhook().catch(() => {}); }   // stream the new wallets immediately
}
