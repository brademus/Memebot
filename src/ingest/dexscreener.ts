import { cfg } from '../config';
import { allTokens } from '../store';
import { TokenRecord } from '../types';

// Dexscreener is the enrichment layer: price, liquidity, mcap, buy/sell txns.
// Free API, batch up to 30 token addresses per call.
const BASE = 'https://api.dexscreener.com/latest/dex/tokens/';

export function startDexscreenerPoller(onUpdated: (t: TokenRecord) => void) {
  let tickN = 0;
  const tick = async () => {
    tickN++;
    // Two-tier polling to spend the API budget where Dexscreener actually helps:
    //  - every tick:   graduated/AMM tokens (Dexscreener is their only data source)
    //  - every 3rd:    curve tokens (live data comes from the pump.fun stream; we
    //                  only need Dexscreener to notice indexing/graduation)
    const tracked = allTokens().filter(t =>
      t.state !== 'DEAD' &&
      (t.dex !== 'pumpfun' || tickN % 3 === 0));
    const batchSize = cfg().limits.dexscreener_batch_size;
    for (let i = 0; i < tracked.length; i += batchSize) {
      await enrich(tracked.slice(i, i + batchSize), onUpdated);
    }
    setTimeout(tick, cfg().polling.dexscreener_interval_ms);
  };
  tick();
}

async function enrich(batch: TokenRecord[], onUpdated: (t: TokenRecord) => void) {
  if (!batch.length) return;
  try {
    const res = await fetch(BASE + batch.map(t => t.ca).join(','));
    if (!res.ok) return;
    const data: any = await res.json();
    const pairs: any[] = data.pairs || [];
    for (const t of batch) {
      const p = pairs
        .filter(p => p.baseToken?.address === t.ca && p.chainId === 'solana')
        .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
      if (!p) continue;
      // FILL IN THE SYMBOL — tokens surfaced by wallets/momentum/boosts start as
      // '?' and rely on enrichment for their identity. This was never being copied
      // out of the Dexscreener response, so every surfaced coin showed as $? on the
      // dashboard forever. Adopt the real symbol/name the moment Dexscreener has it.
      if ((t.symbol === '?' || !t.symbol || t.symbol.endsWith('…')) && p.baseToken?.symbol) t.symbol = p.baseToken.symbol;
      if ((!t.name || t.name.startsWith('(')) && p.baseToken?.name) t.name = p.baseToken.name;
      // only overwrite if Dexscreener has real numbers; else keep curve-seeded values
      const dexLiq = p.liquidity?.usd || 0;
      if (dexLiq > 0) t.liquidityUsd = dexLiq;
      const dexPrice = parseFloat(p.priceUsd || '0');
      if (dexPrice > 0) {
        t.priceUsd = dexPrice;
        // post-graduation peak/trough for the second-wave retrace calc
        if (t.gradAt) {
          if (dexPrice > t.gradPeak) t.gradPeak = dexPrice;
          if (t.gradTrough === 0 || dexPrice < t.gradTrough) t.gradTrough = dexPrice;
        }
      }
      const dexMcap = p.fdv || p.marketCap || 0;
      if (dexMcap > 0) t.mcapUsd = dexMcap;
      // graduation detection: a token gets a REAL AMM pair only after it leaves
      // the curve. Only transition off 'pumpfun' when Dexscreener names a
      // different, real dex — never overwrite with 'pumpfun' or with null/undefined
      // (an unindexed pair), which previously wiped curve state and broke every
      // t.dex === 'pumpfun' code path (gating, persistence, scoring).
      if (p.dexId && p.dexId !== 'pumpfun') { t.dex = p.dexId; t.dexId = p.dexId; }
      t.priceChange5m = p.priceChange?.m5 || 0;
      t.pairAddress = p.pairAddress || t.pairAddress;
      // 5m txn/volume counts: for on-curve tokens the pump.fun stream owns these
      // (real curve trades); Dexscreener has no curve data and would clobber them
      // with 0s. Only adopt Dexscreener's counts once the token has left the curve.
      if (t.dex !== 'pumpfun') {
        t.vol5m = p.volume?.m5 || 0;
        t.buys5m = p.txns?.m5?.buys || 0;
        t.sells5m = p.txns?.m5?.sells || 0;
        t.uniqueBuyerSamples.push(t.buys5m);
        if (t.uniqueBuyerSamples.length > 6) t.uniqueBuyerSamples.shift();
      }
      onUpdated(t);
    }
  } catch (e) {
    console.error('[dexscreener]', (e as Error).message);
  }
}

export async function fetchTokenSnapshot(ca: string): Promise<{ price: number; liq: number; mcap: number } | null> {
  try {
    const res = await fetch(BASE + ca);
    if (!res.ok) return null;
    const data: any = await res.json();
    const p = (data.pairs || []).sort((a: any, b: any) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
    if (!p) return null;
    return { price: parseFloat(p.priceUsd || '0'), liq: p.liquidity?.usd || 0, mcap: p.fdv || 0 };
  } catch { return null; }
}
