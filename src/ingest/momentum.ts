import { cfg } from '../config';
import { addToken, getToken } from '../store';
import { TokenRecord } from '../types';

// MOMENTUM SCANNER — the second discovery engine.
//
// The pump.fun stream only sees BIRTHS. A coin that launches quietly and wakes
// up at hour six was purged at minute twelve; a coin that launches on Raydium,
// LaunchLab, or any other venue never entered the funnel at all. The day's top
// gainer is very often exactly one of those. This scanner closes both holes:
//
//   TRENDING lane — GeckoTerminal's trending pools for Solana: coins already
//   running. The question for these is not "will it move" but "is there still a
//   sane entry" — so the filters demand real liquidity, a real 24h move, and
//   REJECT vertical blow-off candles (a +40% five-minute bar is exit liquidity,
//   not an entry).
//
//   NEW POOLS lane — fresh Solana pools from any venue, catching non-pump.fun
//   launches the websocket can never see.
//
// Found coins enter the SAME pipeline as everything else: full AMM gates
// (RugCheck suite, honeypot sell-sim, LP lock), scoring, states, rank, lanes.
// The scanner finds; the algorithm still decides. playType RUNNER marks them,
// and freshness/moved% measure from OUR discovery — for a second-leg entry the
// question is what happened since WE could have bought, not since mint.

const GT = 'https://api.geckoterminal.com/api/v2/networks/solana';

// majors and quote tokens that trend constantly but are never memecoin plays
const EXCLUDE = new Set([
  'So11111111111111111111111111111111111111112',   // wSOL
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',  // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',  // USDT
  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',   // JUP
  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',  // BONK
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',   // mSOL
  'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn',  // jitoSOL
]);

const recentlyRejected = new Map<string, number>();   // ca -> retry-after ts
const diag = { lastRun: null as string | null, lastError: null as string | null, surfaced: 0, scanned: 0 };
export const momentumDiag = () => ({ ...diag });

export function startMomentumScanner(onFound: (ca: string) => void) {
  const m = cfg().momentum;
  if (!m || !m.enabled) return;
  const tick = () => scan(onFound).catch(e => { diag.lastError = (e as Error).message; });
  setTimeout(tick, 30_000);
  setInterval(tick, Math.max(120, cfg().momentum.poll_seconds) * 1000);
}

async function scan(onFound: (ca: string) => void) {
  const m = cfg().momentum;
  diag.lastRun = new Date().toISOString();
  diag.lastError = null;

  // prune the rejection cache
  const now = Date.now();
  for (const [ca, until] of recentlyRejected) if (until < now) recentlyRejected.delete(ca);

  const pools: any[] = [];
  for (const path of ['/trending_pools', '/new_pools']) {
    try {
      const res = await fetch(`${GT}${path}`, { headers: { accept: 'application/json' } });
      if (!res.ok) continue;
      const data: any = await res.json();
      for (const p of data.data || []) pools.push({ ...p, _lane: path === '/trending_pools' ? 'trending' : 'new' });
    } catch { /* one lane failing must not kill the other */ }
  }
  diag.scanned = pools.length;

  for (const p of pools) {
    const a = p.attributes || {};
    const ca = (p.relationships?.base_token?.data?.id || '').replace(/^solana_/, '');
    if (!ca || EXCLUDE.has(ca)) continue;
    if (getToken(ca)) continue;                            // already in the pipeline
    if ((recentlyRejected.get(ca) || 0) > now) continue;   // recently evaluated, don't churn

    const liq = Number(a.reserve_in_usd) || 0;
    const vol24 = Number(a.volume_usd?.h24) || 0;
    const chg24 = Number(a.price_change_percentage?.h24) || 0;
    const chg5m = Number(a.price_change_percentage?.m5) || 0;
    const ageHours = a.pool_created_at ? (now - Date.parse(a.pool_created_at)) / 3.6e6 : 0;

    const reject = (hours: number) => recentlyRejected.set(ca, now + hours * 3600_000);

    if (liq < m.min_liquidity_usd) { reject(2); continue; }
    if (p._lane === 'trending') {
      if (vol24 < m.min_vol24h_usd) { reject(2); continue; }
      if (ageHours > m.max_age_hours) { reject(24); continue; }      // established coin, different game
      if (chg24 < m.min_change24h_pct) { reject(4); continue; }      // not actually running
      if (chg5m > m.max_change5m_pct) { reject(0.5); continue; }     // vertical blow-off — re-look in 30m
    }

    const t = addToken({
      ca,
      symbol: a.name?.split(' / ')[0]?.trim() || '?',
      name: `(${p._lane === 'trending' ? 'runner' : 'new pool'}: ${a.name || ca.slice(0, 8)})`,
      creator: null,
      source: 'momentum',
    });
    if (!t) continue;

    // seed from the pool snapshot so gates can run immediately; the Dexscreener
    // poller takes over enrichment from here like any other tracked token
    seedFromPool(t, p, a);
    diag.surfaced++;
    console.log(`[momentum] surfaced ${p._lane} $${t.symbol} — liq $${Math.round(liq / 1000)}K, 24h ${chg24 > 0 ? '+' : ''}${Math.round(chg24)}%, age ${ageHours.toFixed(1)}h`);
    onFound(ca);
  }
}

function seedFromPool(t: TokenRecord, p: any, a: any) {
  t.playType = p._lane === 'trending' ? 'RUNNER' : null;
  t.dexId = p.relationships?.dex?.data?.id || 'raydium';
  t.dex = t.dexId;                                    // NOT 'pumpfun' -> gates use the full AMM path
  t.priceUsd = Number(a.base_token_price_usd) || 0;
  t.liquidityUsd = Number(a.reserve_in_usd) || 0;
  t.mcapUsd = Number(a.fdv_usd) || Number(a.market_cap_usd) || 0;
  t.vol5m = Number(a.volume_usd?.m5) || 0;
  t.buys5m = Number(a.transactions?.m5?.buys) || 0;
  t.sells5m = Number(a.transactions?.m5?.sells) || 0;
  t.priceChange5m = Number(a.price_change_percentage?.m5) || 0;
  t.pairAddress = (p.id || '').replace(/^solana_/, '') || null;
}
