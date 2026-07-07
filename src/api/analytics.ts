import { pool } from '../db';
import { activeTokens } from '../store';

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

  if (!pool) return { mostActiveNow, topWallets: [], topCoinsToday: [], todayStats: null, note: 'attach Postgres for wallet + outcome analytics' };

  const q = async (sql: string) => (await pool!.query(sql)).rows;

  // top wallets by measured performance: of the tokens each tracked wallet bought,
  // how many actually 2x'd by the 4h snapshot
  const topWallets = await q(`
    SELECT w.wallet, w.winners_hit, w.active,
           COUNT(h.ca) AS buys_tracked,
           COUNT(o.ca) FILTER (WHERE o.multiple_from_first >= 2) AS wins_2x,
           ROUND(AVG(o.multiple_from_first)::numeric, 2) AS avg_multiple
    FROM smart_wallets w
    LEFT JOIN wallet_hits h ON h.wallet = w.wallet
    LEFT JOIN outcomes o ON o.ca = h.ca AND o.snapshot_minutes = 240
    WHERE w.winners_hit > 0
    GROUP BY w.wallet, w.winners_hit, w.active
    ORDER BY w.active DESC, wins_2x DESC NULLS LAST, w.winners_hit DESC
    LIMIT 25`);

  // top coins today by best realized multiple across any snapshot
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
           COUNT(*) FILTER (WHERE triggered_at IS NOT NULL) AS triggered
    FROM tokens WHERE first_seen > now() - interval '24 hours'`))[0];

  return { mostActiveNow, topWallets, topCoinsToday, todayStats };
}
