import { cfg } from '../config';
import { pool } from '../db';
import { addToken, getToken } from '../store';

// MISSED WINNERS — the accountability board.
//
// Every coin that did 5x+ and never got called is a lesson, and some of them are
// still tradeable. This module finds both kinds of miss:
//
//   INTERNAL — coins we SAW but didn't call: killed by a gate, or passed and
//   never triggered. The outcomes table already measures them (killed tokens get
//   snapshots from their kill-time price), so these come from our own DB with the
//   exact reason attached. These are also the filter learner's fuel — a gate that
//   shows up here repeatedly is already being loosened automatically.
//
//   EXTERNAL — coins we NEVER SAW: launched outside pump.fun before the momentum
//   scanner existed, or missed by its filters. Sourced by sweeping GeckoTerminal
//   trending + top-volume pools for anything up 400%+ on the day whose CA has no
//   row in our tokens table. This bucket is the discovery engines' report card.
//
// "How good could it still be": every miss gets a live viability read — and a
// miss that still qualifies is INJECTED into the pipeline (momentum lane, full
// gates), so the dashboard can show its live score instead of a shrug.

const GT = 'https://api.geckoterminal.com/api/v2/networks/solana';

export interface MissedWinner {
  ca: string;
  symbol: string;
  peak: string;              // "7.2x" (internal, measured) or "+540%" (external, 24h)
  whyMissed: string;
  now: string;               // live viability verdict
  reSurfaced: boolean;       // true = it's back in the pipeline, check the watchlist
  liq: number;
  pair: string | null;
}

let cache: { at: number; misses: MissedWinner[]; summary: string } = { at: 0, misses: [], summary: '' };

export async function getMissedWinners(): Promise<{ misses: MissedWinner[]; summary: string }> {
  if (Date.now() - cache.at < 10 * 60_000) return cache;
  const misses: MissedWinner[] = [];
  let killed = 0, untriggered = 0, unseen = 0;

  // ---- INTERNAL: seen but not called ----
  if (pool) {
    try {
      const r = await pool.query(`
        SELECT t.ca, t.symbol, t.gate_result, t.gate_fail_reason, t.triggered_at, t.last_score,
               MAX(o.multiple_from_first) AS best
        FROM tokens t JOIN outcomes o ON o.ca = t.ca
        WHERE t.first_seen > now() - interval '48 hours'
          AND o.multiple_from_first IS NOT NULL
        GROUP BY t.ca, t.symbol, t.gate_result, t.gate_fail_reason, t.triggered_at, t.last_score
        HAVING MAX(o.multiple_from_first) >= 5
           AND (t.gate_result = 'failed' OR t.triggered_at IS NULL)
        ORDER BY MAX(o.multiple_from_first) DESC LIMIT 15`);
      for (const row of r.rows) {
        const isKill = row.gate_result === 'failed';
        isKill ? killed++ : untriggered++;
        misses.push({
          ca: row.ca,
          symbol: row.symbol || '?',
          peak: Number(row.best).toFixed(1) + 'x',
          whyMissed: isKill
            ? `killed by gate: ${row.gate_fail_reason || 'unknown'}`
            : `passed gates but never triggered (peaked at score ${row.last_score ?? '?'})`,
          now: '', reSurfaced: false, liq: 0, pair: null,
        });
      }
    } catch { /* db down: external bucket still works */ }
  }

  // ---- EXTERNAL: never seen at all ----
  try {
    const pools: any[] = [];
    for (const path of ['/trending_pools', '/pools?sort=h24_volume_usd_desc']) {
      const res = await fetch(`${GT}${path}`, { headers: { accept: 'application/json' } });
      if (res.ok) pools.push(...(((await res.json()) as any).data || []));
    }
    for (const p of pools) {
      const a = p.attributes || {};
      const ca = (p.relationships?.base_token?.data?.id || '').replace(/^solana_/, '');
      const chg24 = Number(a.price_change_percentage?.h24) || 0;
      if (!ca || chg24 < 400) continue;                       // 5x day = +400%
      if (misses.some(m => m.ca === ca)) continue;
      const known = pool ? (await pool.query(`SELECT 1 FROM tokens WHERE ca = $1`, [ca])).rowCount : 0;
      if (known) continue;                                    // internal bucket owns seen coins
      unseen++;
      misses.push({
        ca,
        symbol: a.name?.split(' / ')[0]?.trim() || ca.slice(0, 6),
        peak: `+${Math.round(chg24)}%`,
        whyMissed: 'never seen — outside all discovery sources',
        now: assessPool(a),
        reSurfaced: maybeInject(ca, a, p),
        liq: Math.round(Number(a.reserve_in_usd) || 0),
        pair: (p.id || '').replace(/^solana_/, '') || null,
      });
      if (misses.length >= 25) break;
    }
  } catch { /* external sweep is best-effort */ }

  // ---- live viability for internal misses (their DB data is stale) ----
  for (const m of misses.filter(x => !x.now)) {
    try {
      const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${m.ca}`);
      const data: any = res.ok ? await res.json() : null;
      const p = (data?.pairs || []).sort((x: any, y: any) => (y.liquidity?.usd || 0) - (x.liquidity?.usd || 0))[0];
      if (!p) { m.now = 'GONE — no liquidity left, it round-tripped'; continue; }
      m.liq = Math.round(p.liquidity?.usd || 0);
      m.pair = p.pairAddress || null;
      m.now = assess(p.liquidity?.usd || 0, Number(p.priceChange?.m5) || 0, Number(p.priceChange?.h1) || 0, Number(p.volume?.h24) || 0);
      if (m.now.startsWith('STILL ALIVE')) m.reSurfaced = injectByCa(m.ca, p);
    } catch { m.now = 'unknown — snapshot failed'; }
  }

  const summary = `${misses.length} five-x misses in 48h — ${killed} gate-killed · ${untriggered} passed-but-never-triggered · ${unseen} never seen`;
  cache = { at: Date.now(), misses, summary };
  return cache;
}

function assess(liq: number, m5: number, h1: number, vol24: number): string {
  const mm = cfg().momentum;
  if (liq < (mm?.min_liquidity_usd ?? 30000)) return `DONE — liq down to $${Math.round(liq / 1000)}K, exit already happened`;
  if (h1 < -25) return `DYING — -${Math.abs(Math.round(h1))}% last hour, don't chase the corpse`;
  if (m5 > (mm?.max_change5m_pct ?? 45)) return 'VERTICAL — blow-off candle right now, wait for structure';
  if (vol24 < (mm?.min_vol24h_usd ?? 150000)) return 'FADING — volume gone, move on';
  return `STILL ALIVE — $${Math.round(liq / 1000)}K liq, ${h1 >= 0 ? '+' : ''}${Math.round(h1)}% 1h — re-surfaced into the pipeline`;
}

function assessPool(a: any): string {
  return assess(Number(a.reserve_in_usd) || 0, Number(a.price_change_percentage?.m5) || 0,
    Number(a.price_change_percentage?.h1) || 0, Number(a.volume_usd?.h24) || 0);
}

// inject a still-viable miss into the live pipeline — full gates still apply,
// the panel just points at the watchlist for its live grade
function maybeInject(ca: string, a: any, p: any): boolean {
  if (!assessPool(a).startsWith('STILL ALIVE')) return false;
  if (getToken(ca)) return true;
  const t = addToken({ ca, symbol: a.name?.split(' / ')[0]?.trim() || '?', name: '(missed winner re-surfaced)', creator: null, source: 'momentum' });
  if (!t) return false;
  t.playType = 'RUNNER';
  t.dexId = p.relationships?.dex?.data?.id || 'raydium';
  t.dex = t.dexId;
  t.priceUsd = Number(a.base_token_price_usd) || 0;
  t.liquidityUsd = Number(a.reserve_in_usd) || 0;
  t.mcapUsd = Number(a.fdv_usd) || 0;
  t.pairAddress = (p.id || '').replace(/^solana_/, '') || null;
  console.log(`[missed] re-surfaced never-seen winner ${ca} into the pipeline`);
  return true;
}

function injectByCa(ca: string, pair: any): boolean {
  if (getToken(ca)) return true;
  const t = addToken({ ca, symbol: pair.baseToken?.symbol || '?', name: '(missed winner re-surfaced)', creator: null, source: 'momentum' });
  if (!t) return false;
  t.playType = 'RUNNER';
  t.dex = pair.dexId || 'raydium';
  t.dexId = t.dex;
  t.priceUsd = parseFloat(pair.priceUsd || '0');
  t.liquidityUsd = pair.liquidity?.usd || 0;
  t.mcapUsd = pair.fdv || 0;
  t.pairAddress = pair.pairAddress || null;
  console.log(`[missed] re-surfaced missed winner $${t.symbol} into the pipeline`);
  return true;
}
