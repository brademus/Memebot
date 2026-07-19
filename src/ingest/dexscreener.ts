import { cfg } from '../config';
import { allTokens } from '../store';
import { MarketSample, TokenRecord } from '../types';
import { backfillWalletEntryPrice } from '../wallets/ledger';
import { getStreamMode } from './pumpfun';

const BASE = 'https://api.dexscreener.com/latest/dex/tokens/';

export function startDexscreenerPoller(onUpdated: (t: TokenRecord) => void) {
  let tickN = 0;
  const tick = async () => {
    tickN++;
    const floor = cfg().states.trigger_score_min;
    const hot = (t: TokenRecord) =>
      t.score >= floor - 10 || ['HEATING', 'TRIGGER', 'EXTENDED'].includes(t.state)
      || t.playType === 'GRADUATION' || t.playType === 'REVIVAL' || !!t.secondWaveAt;
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
      if (!t.marketCreatedAt && Number(pair.pairCreatedAt) > 0) t.marketCreatedAt = Number(pair.pairCreatedAt);
      const dexLiquidity = pair.liquidity?.usd || 0;
      if (dexLiquidity > 0) t.liquidityUsd = dexLiquidity;
      const dexPrice = parseFloat(pair.priceUsd || '0');
      if (dexPrice > 0) {
        t.priceUsd = dexPrice;
        (t as any).marketUpdatedAt = Date.now();
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
      // PumpPortal trade subscriptions are metered and absent in lite mode. Keep the
      // score and model fed from Dexscreener aggregates until Helius reconstructs the
      // individual sequence. In full mode, the exact websocket events remain canonical.
      if (t.dex !== 'pumpfun' || getStreamMode() === 'lite') {
        t.vol5m = pair.volume?.m5 || 0;
        t.buys5m = pair.txns?.m5?.buys || 0;
        t.sells5m = pair.txns?.m5?.sells || 0;
        t.uniqueBuyerSamples.push(t.buys5m);
        if (t.uniqueBuyerSamples.length > 30) t.uniqueBuyerSamples.shift();
      }
      capturePairSocials(t, pair);
      appendMarketSample(t, Date.now());
      onUpdated(t);
    }
  } catch (error) { console.error('[dexscreener]', (error as Error).message); }
}

function capturePairSocials(token: TokenRecord, pair: any) {
  const info = pair?.info;
  if (!info) return;
  const socialRows = Array.isArray(info.socials) ? info.socials : [];
  const websiteRows = Array.isArray(info.websites) ? info.websites : [];
  const has = (needle: string) => socialRows.some((row: any) =>
    String(row?.type || '').toLowerCase().includes(needle)
    || String(row?.url || '').toLowerCase().includes(needle));
  token.socials = {
    x: token.socials.x || has('twitter') || has('x.com'),
    tg: token.socials.tg || has('telegram') || has('t.me'),
    web: token.socials.web || websiteRows.some((row: any) => String(row?.url || '').startsWith('http')),
    fetched: true,
    tgMembers: token.socials.tgMembers,
  };
}

export function appendMarketSample(token: TokenRecord, at = Date.now()) {
  if (!(token.priceUsd > 0) || !(token.liquidityUsd > 0)) return;
  const previous = token.marketSamples[token.marketSamples.length - 1];
  if (previous && at - previous.at < 5_000) return;
  const sample: MarketSample = {
    at,
    priceUsd: token.priceUsd,
    liquidityUsd: token.liquidityUsd,
    vol5m: token.vol5m,
    buys5m: token.buys5m,
    sells5m: token.sells5m,
  };
  token.marketSamples.push(sample);
  if (token.marketSamples.length > 180) token.marketSamples.splice(0, token.marketSamples.length - 180);
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
