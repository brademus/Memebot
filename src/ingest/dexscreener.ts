import { cfg } from '../config';
import { allTokens } from '../store';
import { TokenRecord } from '../types';

// Dexscreener is the enrichment layer: price, liquidity, mcap, buy/sell txns.
// Free API, batch up to 30 token addresses per call.
const BASE = 'https://api.dexscreener.com/latest/dex/tokens/';

export function startDexscreenerPoller(onUpdated: (t: TokenRecord) => void) {
  const tick = async () => {
    const tracked = allTokens().filter(t => t.state !== 'DEAD');
    const batchSize = cfg().limits.dexscreener_batch_size;
    for (let i = 0; i < tracked.length; i += batchSize) {
      const batch = tracked.slice(i, i + batchSize);
      await enrich(batch, onUpdated);
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
      t.priceUsd = parseFloat(p.priceUsd || '0');
      t.liquidityUsd = p.liquidity?.usd || 0;
      t.mcapUsd = p.fdv || p.marketCap || 0;
      t.vol5m = p.volume?.m5 || 0;
      t.buys5m = p.txns?.m5?.buys || 0;
      t.sells5m = p.txns?.m5?.sells || 0;
      t.priceChange5m = p.priceChange?.m5 || 0;
      t.pairAddress = p.pairAddress || null;
      t.dex = p.dexId || null;
      t.dexId = p.dexId || null;
      t.uniqueBuyerSamples.push(t.buys5m);
      if (t.uniqueBuyerSamples.length > 6) t.uniqueBuyerSamples.shift();
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
