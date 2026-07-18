import { cfg, env } from '../config';
import { pool } from '../db';
import { earlyBuyers } from '../helius';
import { analyzeWallet, WalletQuality } from './quality';
import { syncWebhook } from './webhook';

// Two independent wallet-discovery lanes feed the same tracked-wallet table:
// 1) winner mining starts from tokens that already proved they could move;
// 2) activity mining starts from wallets trading Pump.fun heavily, then promotes
//    only wallets whose own Helius history proves positive realized P&L and ROI.
// Every promoted wallet is streamed by the existing webhook/tracker, and every buy
// it makes is surfaced into the normal gates -> score -> watchlist -> conviction path.

const GT = 'https://api.geckoterminal.com/api/v2/networks/solana';

const ACTIVITY_LOOKBACK_HOURS = 6;
const ACTIVITY_MIN_TRADES = 18;
const ACTIVITY_MIN_BUYS = 10;
const ACTIVITY_MIN_TOKENS = 5;
const ACTIVITY_MAX_VET = 30;
const ACTIVITY_INTERVAL_MS = 60 * 60_000;
const PROFIT_MIN_ROUND_TRIPS = 5;
const PROFIT_MIN_PNL_SOL = 0.15;
const PROFIT_MIN_ROI = 0.03;

export interface PumpfunActivityCandidate {
  wallet: string;
  trades: number;
  buys: number;
  sells: number;
  tokens: number;
  buySol: number;
  lastTradeAt: string | null;
}

const diag = {
  lastRun: null as string | null,
  lastError: null as string | null,
  moversScanned: 0,
  candidatesfound: 0,
  tracked: 0,
  vetted: 0,
  rejected: 0,
  marginal: 0,
  activityLastRun: null as string | null,
  activityLastError: null as string | null,
  activityCandidates: 0,
  activityVetted: 0,
  activityPromoted: 0,
  activityRejected: 0,
};
export const winnerMinerDiag = () => ({ ...diag });

export function qualifiesActivityWallet(
  quality: Pick<WalletQuality, 'roundTrips' | 'realizedPnlSol' | 'realizedRoi' | 'verdict'>,
  activity: Pick<PumpfunActivityCandidate, 'trades' | 'buys' | 'tokens'>,
): boolean {
  return activity.trades >= ACTIVITY_MIN_TRADES
    && activity.buys >= ACTIVITY_MIN_BUYS
    && activity.tokens >= ACTIVITY_MIN_TOKENS
    && quality.roundTrips >= PROFIT_MIN_ROUND_TRIPS
    && quality.realizedPnlSol >= PROFIT_MIN_PNL_SOL
    && quality.realizedRoi >= PROFIT_MIN_ROI
    && (quality.verdict === 'GOOD' || quality.verdict === 'ELITE');
}

export function startWinnerWalletMiner() {
  if (!pool || !env.HELIUS_API_KEY || !cfg().wallets.winner_mining_enabled) return;

  const winnerTick = () => runWinnerMining().catch(error => {
    diag.lastError = (error as Error).message;
    console.error('[winner-miner]', diag.lastError);
  });
  const activityTick = () => runPumpfunActivityMining().catch(error => {
    diag.activityLastError = (error as Error).message;
    console.error('[activity-miner]', diag.activityLastError);
  });

  setTimeout(winnerTick, 6 * 60_000);
  setInterval(winnerTick, Math.max(1, cfg().wallets.winner_mining_hours) * 3600_000);
  setTimeout(activityTick, 4 * 60_000);
  setInterval(activityTick, ACTIVITY_INTERVAL_MS);
}

async function runWinnerMining() {
  if (!pool) return;
  const settings = cfg().wallets;
  diag.lastRun = new Date().toISOString();
  diag.lastError = null;

  // The market's biggest movers nominate early buyers.
  const movers: { ca: string; chg: number }[] = [];
  for (const path of ['/pools?sort=h24_volume_usd_desc', '/trending_pools']) {
    try {
      const response = await fetch(`${GT}${path}`, { headers: { accept: 'application/json' } });
      if (!response.ok) continue;
      const data: any = await response.json();
      for (const item of data.data || []) {
        const ca = (item.relationships?.base_token?.data?.id || '').replace(/^solana_/, '');
        const change = Number(item.attributes?.price_change_percentage?.h24) || 0;
        if (ca && change >= settings.winner_mining_min_pct) movers.push({ ca, chg: change });
      }
    } catch { /* best effort */ }
  }
  diag.moversScanned = movers.length;
  if (!movers.length) return;

  const candidates = new Map<string, number>();
  const tracked = new Set((await pool.query(`SELECT wallet FROM smart_wallets`).catch(() => ({ rows: [] as any[] })))
    .rows.map((row: any) => row.wallet));
  for (const mover of movers.slice(0, settings.winner_mining_max_mints)) {
    const buyers = await earlyBuyers(mover.ca, 3).catch(() => [] as string[]);
    for (const buyer of buyers) {
      if (tracked.has(buyer)) continue;
      candidates.set(buyer, Math.max(candidates.get(buyer) || 0, mover.chg));
    }
  }
  diag.candidatesfound = candidates.size;

  let added = 0;
  const ranked = [...candidates.entries()].sort((left, right) => right[1] - left[1]).slice(0, settings.winner_mining_max_vet);
  diag.vetted = 0;
  diag.rejected = 0;
  diag.marginal = 0;
  for (const [wallet, moverPct] of ranked) {
    const quality = await analyzeWallet(wallet);
    diag.vetted++;
    if (quality.verdict === 'REJECT') { diag.rejected++; continue; }
    if (quality.verdict === 'MARGINAL') { diag.marginal++; continue; }
    await pool.query(
      `INSERT INTO smart_wallets
         (wallet,type,winners_hit,discovered_from,active,last_validated,quality_verdict,win_rate,round_trips,quality_checked_at)
       VALUES ($1,'winner_miner',1,'winner_mining',true,now(),$2,$3,$4,now())
       ON CONFLICT (wallet) DO UPDATE SET
         active=true,last_validated=now(),quality_verdict=$2,win_rate=$3,round_trips=$4,quality_checked_at=now()`,
      [wallet, quality.verdict, +quality.winRate.toFixed(3), quality.roundTrips]);
    added++;
    console.log(`[winner-miner] +${wallet.slice(0, 6)} — early on +${Math.round(moverPct)}%, ${quality.verdict}, `
      + `${quality.realizedPnlSol.toFixed(2)} SOL realized, ${(quality.realizedRoi * 100).toFixed(0)}% ROI`);
  }
  diag.tracked = added;
  if (added > 0) syncWebhook().catch(() => {});
}

export async function runPumpfunActivityMining() {
  if (!pool) return winnerMinerDiag();
  diag.activityLastRun = new Date().toISOString();
  diag.activityLastError = null;
  diag.activityVetted = 0;
  diag.activityPromoted = 0;
  diag.activityRejected = 0;

  // Heavy activity is measured from every Pump.fun trade event currently captured
  // by the bot's full token stream. Activity nominates; realized profitability decides.
  const result = await pool.query(`
    WITH activity AS (
      SELECT wallet,
             COUNT(*)::int AS trades,
             COUNT(*) FILTER (WHERE side='buy')::int AS buys,
             COUNT(*) FILTER (WHERE side='sell')::int AS sells,
             COUNT(DISTINCT ca)::int AS tokens,
             COALESCE(SUM(sol_amount) FILTER (WHERE side='buy'),0)::float AS buy_sol,
             MAX(at) AS last_trade_at
        FROM trade_events
       WHERE source='pumpfun'
         AND wallet IS NOT NULL
         AND wallet <> ''
         AND at > now()-($1||' hours')::interval
       GROUP BY wallet
      HAVING COUNT(*) >= $2
         AND COUNT(*) FILTER (WHERE side='buy') >= $3
         AND COUNT(DISTINCT ca) >= $4
    )
    SELECT activity.*
      FROM activity
      LEFT JOIN smart_wallets known ON known.wallet=activity.wallet
     ORDER BY (known.wallet IS NULL) DESC,
              (known.active IS FALSE) DESC,
              activity.trades DESC,activity.tokens DESC,activity.buy_sol DESC
     LIMIT $5`, [String(ACTIVITY_LOOKBACK_HOURS), ACTIVITY_MIN_TRADES, ACTIVITY_MIN_BUYS, ACTIVITY_MIN_TOKENS, ACTIVITY_MAX_VET]);

  const candidates: PumpfunActivityCandidate[] = result.rows.map((row: any) => ({
    wallet: row.wallet,
    trades: Number(row.trades) || 0,
    buys: Number(row.buys) || 0,
    sells: Number(row.sells) || 0,
    tokens: Number(row.tokens) || 0,
    buySol: Number(row.buy_sol) || 0,
    lastTradeAt: row.last_trade_at || null,
  }));
  diag.activityCandidates = candidates.length;

  let promotedAny = false;
  for (const activity of candidates) {
    const quality = await analyzeWallet(activity.wallet, 6);
    const promoted = qualifiesActivityWallet(quality, activity);
    diag.activityVetted++;
    if (promoted) { diag.activityPromoted++; promotedAny = true; }
    else diag.activityRejected++;

    const nextType = promoted ? 'pumpfun_activity' : 'pumpfun_candidate';
    const source = `pumpfun_activity:${activity.trades}trades/${activity.tokens}tokens/${ACTIVITY_LOOKBACK_HOURS}h`;
    await pool.query(
      `INSERT INTO smart_wallets
         (wallet,type,winners_hit,discovered_from,active,last_validated,quality_verdict,win_rate,round_trips,quality_checked_at,last_active)
       VALUES ($1,$2,0,$3,$4,now(),$5,$6,$7,now(),$8)
       ON CONFLICT (wallet) DO UPDATE SET
         type=CASE WHEN smart_wallets.type IN ('pumpfun_candidate','pumpfun_activity') THEN EXCLUDED.type ELSE smart_wallets.type END,
         discovered_from=CASE WHEN smart_wallets.type IN ('pumpfun_candidate','pumpfun_activity') THEN EXCLUDED.discovered_from ELSE smart_wallets.discovered_from END,
         active=CASE
           WHEN smart_wallets.type IN ('pumpfun_candidate','pumpfun_activity') THEN EXCLUDED.active
           ELSE smart_wallets.active OR EXCLUDED.active
         END,
         last_validated=now(),quality_verdict=EXCLUDED.quality_verdict,win_rate=EXCLUDED.win_rate,
         round_trips=EXCLUDED.round_trips,quality_checked_at=now(),
         last_active=COALESCE(GREATEST(smart_wallets.last_active,EXCLUDED.last_active),EXCLUDED.last_active,smart_wallets.last_active)`,
      [activity.wallet, nextType, source, promoted, quality.verdict, +quality.winRate.toFixed(3), quality.roundTrips, activity.lastTradeAt]);

    const verdict = promoted ? 'PROMOTED' : 'candidate only';
    console.log(`[activity-miner] ${verdict} ${activity.wallet.slice(0, 6)} — ${activity.trades} trades/${activity.tokens} tokens, `
      + `${quality.realizedPnlSol.toFixed(2)} SOL, ${(quality.realizedRoi * 100).toFixed(0)}% ROI, ${quality.verdict}`);
  }

  if (promotedAny) syncWebhook().catch(() => {});
  return winnerMinerDiag();
}
