import { pool } from '../db';
import { activeTokens } from '../store';
import { analyzeWalletToday } from '../wallets/quality';

// Dashboard analytics. All from OUR data — wallets we discovered, tokens we scanned,
// outcomes we measured. No external leaderboards.
export async function buildAnalytics(): Promise<any> {
  const mostActiveNow = activeTokens()
    .sort((a, b) => b.vol5m - a.vol5m)
    .slice(0, 10)
    .map(t => ({
      ca: t.ca, symbol: t.symbol, state: t.state, score: t.score,
      vol5m: Math.round(t.vol5m), txns5m: t.buys5m + t.sells5m,
      liq: Math.round(t.liquidityUsd),
    }));

  if (!pool) return {
    mostActiveNow, topWallets: [], topCoinsToday: [], todayStats: null,
    activeWallets: 0, note: 'attach Postgres for wallet + outcome analytics',
  };

  const q = async (sql: string) => (await pool!.query(sql)).rows;

  const topWallets = await q(`
    SELECT w.wallet, w.winners_hit, w.active, w.quality_verdict, w.win_rate, w.round_trips, w.discovered_from,
           w.last_active,
           EXTRACT(EPOCH FROM (now() - w.last_active))/3600 AS hours_since_active,
           COUNT(h.ca) AS buys_tracked,
           COUNT(o.ca) FILTER (WHERE o.multiple_from_first >= 2) AS wins_2x,
           ROUND(AVG(o.multiple_from_first)::numeric, 2) AS avg_multiple
    FROM smart_wallets w
    LEFT JOIN wallet_hits h ON h.wallet = w.wallet
    LEFT JOIN outcomes o ON o.ca = h.ca AND o.snapshot_minutes = 240
    WHERE w.winners_hit > 0 OR w.discovered_from = 'cobuyer_expansion'
    GROUP BY w.wallet, w.winners_hit, w.active, w.quality_verdict, w.win_rate, w.round_trips, w.discovered_from, w.last_active
    ORDER BY
      (w.last_active > now() - interval '24 hours') DESC,
      w.active DESC, (w.quality_verdict='ELITE') DESC, wins_2x DESC NULLS LAST, w.winners_hit DESC
    LIMIT 25`);

  // Enrich only the most relevant wallets. The analyzer is cached for three minutes,
  // runs in Helius' background lane, and never blocks live scanner traffic.
  const enrichedWallets = await Promise.all(topWallets.map(async (wallet: any, index: number) => {
    if (index >= 10 || !wallet.active) return { ...wallet, day: null };
    try { return { ...wallet, day: await analyzeWalletToday(wallet.wallet) }; }
    catch { return { ...wallet, day: null }; }
  }));

  const topCoinsToday = await q(`
    SELECT t.ca, t.symbol, t.gate_result, t.last_state,
           ROUND(MAX(o.multiple_from_first)::numeric, 2) AS best_multiple
    FROM tokens t LEFT JOIN outcomes o ON o.ca = t.ca
    WHERE t.first_seen > now() - interval '24 hours'
    GROUP BY t.ca, t.symbol, t.gate_result, t.last_state
    HAVING MAX(o.multiple_from_first) IS NOT NULL
    ORDER BY best_multiple DESC LIMIT 10`);

  const todayStats = (await q(`
    SELECT COUNT(*) AS seen,
           COUNT(*) FILTER (WHERE gate_result = 'passed') AS passed,
           COUNT(*) FILTER (WHERE triggered_at IS NOT NULL) AS triggered,
           COUNT(*) FILTER (WHERE conviction_at IS NOT NULL) AS convictions
    FROM tokens WHERE first_seen > now() - interval '24 hours'`))[0];

  const walletSummary = (await q(`
    SELECT COUNT(*) FILTER (WHERE active)::int AS active,
           COUNT(*) FILTER (WHERE last_active > now() - interval '24 hours')::int AS active_today
    FROM smart_wallets`))[0];

  return {
    mostActiveNow,
    topWallets: enrichedWallets,
    topCoinsToday,
    todayStats,
    activeWallets: Number(walletSummary?.active || 0),
    walletsActiveToday: Number(walletSummary?.active_today || 0),
  };
}
