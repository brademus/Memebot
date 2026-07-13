import { cfg } from '../config';
import { allTokens } from '../store';
import { TokenRecord } from '../types';
import { backfillWalletEntryPrice } from '../wallets/ledger';

const BASE = 'https://api.dexscreener.com/latest/dex/tokens/';

export function startDexscreenerPoller(onUpdated: (t: TokenRecord) => void) {
  let tickN = 0;
  const tick = async () => {
    tickN++;
    const floor = cfg().states.trigger_score_min;
    const hot = (t: TokenRecord) =>
      t.score >= floor - 10 || ['HEATING', 'TRIGGER', 'EXTENDED'].includes(t.state)
      || t.playType === 'GRADUATION' || !!t.secondWaveAt;
    const tracked = allTokens().filter(t =>
      t.state !== 'DEAD' && (hot(t) || t.dex !== 'pumpfun' || tickN % 3 === 0));
    const batchSize = cfg().limits.dexscreener_batch_size;
    const batches: TokenRecord[][] = [];
    for (let i = 0; i < tracked.length; i += batchSize) batches.push(tracked.slice(i, i + batchSize));
    for (let i = 0; i < batches.length; i += 3)
      await Promise.all(batches.slice(i, i + 3).map(batch => enrich(batch, onUpdated)));
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
      const pair = pairs
        .filter(candidate => candidate.baseToken?.address === t.ca && candidate.chainId === 'solana')
        .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
      if (!pair) continue;
      if ((t.symbol === '?' || !t.symbol || t.symbol.endsWith('…')) && pair.baseToken?.symbol) t.symbol = pair.baseToken.symbol;
      if ((!t.name || t.name.startsWith('(')) && pair.baseToken?.name) t.name = pair.baseToken.name;
      const dexLiquidity = pair.liquidity?.usd || 0;
      if (dexLiquidity > 0) t.liquidityUsd = dexLiquidity;
      const dexPrice = parseFloat(pair.priceUsd || '0');
      if (dexPrice > 0) {
        t.priceUsd = dexPrice;
        backfillWalletEntryPrice(t.ca, dexPrice).catch(() => {});
        if (t.gradAt) {
          if (dexPrice > t.gradPeak) t.gradPeak = dexPrice;
          if (t.gradTrough === 0 || dexPrice < t.gradTrough) t.gradTrough = dexPrice;
        }
      }
      const dexMcap = pair.fdv || pair.marketCap || 0;
      if (dexMcap > 0) t.mcapUsd = dexMcap;
      if (pair.dexId && pair.dexId !== 'pumpfun') { t.dex = pair.dexId; t.dexId = pair.dexId; }
      t.priceChange5m = pair.priceChange?.m5 || 0;
      t.pairAddress = pair.pairAddress || t.pairAddress;
      if (t.dex !== 'pumpfun') {
        t.vol5m = pair.volume?.m5 || 0;
        t.buys5m = pair.txns?.m5?.buys || 0;
        t.sells5m = pair.txns?.m5?.sells || 0;
        t.uniqueBuyerSamples.push(t.buys5m);
        if (t.uniqueBuyerSamples.length > 6) t.uniqueBuyerSamples.shift();
      }
      onUpdated(t);
    }
  } catch (error) { console.error('[dexscreener]', (error as Error).message); }
}

export async function fetchTokenSnapshot(ca: string): Promise<{ price: number; liq: number; mcap: number } | null> {
  try {
    const res = await fetch(BASE + ca);
    if (!res.ok) return null;
    const data: any = await res.json();
    const pair = (data.pairs || []).sort((a: any, b: any) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
    if (!pair) return null;
    return { price: parseFloat(pair.priceUsd || '0'), liq: pair.liquidity?.usd || 0, mcap: pair.fdv || pair.marketCap || 0 };
  } catch { return null; }
}
