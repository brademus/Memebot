import WebSocket from 'ws';
import { addToken, getToken, allTokens, recordScan } from '../store';
import { bumpDeployer, upsertToken } from '../db';
import { prefilter } from '../gates/prefilter';
import { env } from '../config';
import { fetchSocials } from './metadata';
import { recordTradeEvent } from '../market/trade-events';
import { TradeEvent } from '../types';

let SOL_USD = 150;
export function setSolPrice(price: number) { if (price > 0) SOL_USD = price; }
export const getSolPrice = () => SOL_USD;

function normalizeSol(value: unknown): number | null {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return amount > 1_000_000 ? amount / 1_000_000_000 : amount;
}
function normalizeToken(value: unknown): number | null {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

function seedCurve(t: any, msg: any) {
  const now = Date.now();
  const solInCurve = Number(msg.vSolInBondingCurve || 0);
  const tokensInCurve = Number(msg.vTokensInBondingCurve || 0);
  const mcapSol = Number(msg.marketCapSol || 0);
  t.curveSol = solInCurve;
  t.liquidityUsd = solInCurve * SOL_USD;
  t.mcapUsd = mcapSol * SOL_USD;
  if (solInCurve > 0 && tokensInCurve > 0) t.priceUsd = (solInCurve / tokensInCurve) * SOL_USD;
  if (t.priceUsd > 0) t.marketUpdatedAt = now;
  t.dex = 'pumpfun';
  t.dexId = 'pumpfun';
  if (msg.initialBuy || msg.solAmount) t.buys5m = 1;
  if (msg.initialBuy) t.devBuyPct = Math.min(100, (Number(msg.initialBuy) / 1e9) * 100);
  t.curveSamples = [{ sol: solInCurve, at: now }];
}

function applyCurveTrade(msg: any) {
  const t = getToken(msg.mint);
  if (!t) return;
  const now = Date.now();
  if (msg.vSolInBondingCurve) {
    t.curveSol = Number(msg.vSolInBondingCurve);
    t.peakCurveSol = Math.max(t.peakCurveSol, t.curveSol);
    t.liquidityUsd = t.curveSol * SOL_USD;
  }
  if (msg.marketCapSol) t.mcapUsd = Number(msg.marketCapSol) * SOL_USD;
  if (msg.vSolInBondingCurve && msg.vTokensInBondingCurve) {
    t.priceUsd = (Number(msg.vSolInBondingCurve) / Number(msg.vTokensInBondingCurve)) * SOL_USD;
    t.marketUpdatedAt = now;
  }

  const wallet = String(msg.traderPublicKey || msg.user || msg.trader || '') || null;
  const buy = msg.txType === 'buy';
  const event: TradeEvent = {
    at: now,
    buy,
    wallet,
    solAmount: normalizeSol(msg.solAmount ?? msg.sol_amount),
    tokenAmount: normalizeToken(msg.tokenAmount ?? msg.token_amount),
    signature: String(msg.signature || msg.txSignature || msg.tx || '') || null,
    slot: Number.isFinite(Number(msg.slot)) ? Number(msg.slot) : null,
    priceUsd: t.priceUsd || null,
    curveSol: t.curveSol || null,
  };

  if (buy) {
    t.totalBuys++;
    if (wallet && !t.uniqueBuyers.includes(wallet) && t.uniqueBuyers.length < 800) t.uniqueBuyers.push(wallet);
    if (wallet && t.earlyBuyers.length < 25 && !t.earlyBuyers.includes(wallet)) t.earlyBuyers.push(wallet);
  } else {
    t.totalSells++;
    if (wallet && t.earlyBuyers.includes(wallet) && !t.earlyExited.includes(wallet)) t.earlyExited.push(wallet);
  }
  t.recentTrades.push(event);
  recordTradeEvent(t.ca, event);

  const cutoff = now - 5 * 60_000;
  while (t.recentTrades.length && t.recentTrades[0].at < cutoff) t.recentTrades.shift();
  if (t.dex === 'pumpfun') {
    t.buys5m = t.recentTrades.filter(trade => trade.buy).length;
    t.sells5m = t.recentTrades.length - t.buys5m;
  }
  if (buy) {
    t.uniqueBuyerSamples.push(t.uniqueBuyers.length);
    if (t.uniqueBuyerSamples.length > 12) t.uniqueBuyerSamples.shift();
  }
  t.curveSamples.push({ sol: t.curveSol, at: now });
  if (t.curveSamples.length > 120) t.curveSamples.shift();
}

const WS_URL = () => 'wss://pumpportal.fun/api/data' + (env.PUMPPORTAL_API_KEY ? `?api-key=${env.PUMPPORTAL_API_KEY}` : '');
let streamMode: 'full' | 'lite' = env.PUMPPORTAL_API_KEY ? 'full' : 'lite';
export const getStreamMode = () => streamMode;
let ws: WebSocket | null = null;
let backoff = 1000;

export function startPumpfunMonitor(onNew: (ca: string) => void) { connect(onNew); }

function connect(onNew: (ca: string) => void) {
  ws = new WebSocket(WS_URL());
  ws.on('open', () => {
    backoff = 1000;
    ws!.send(JSON.stringify({ method: 'subscribeNewToken' }));
    ws!.send(JSON.stringify({ method: 'subscribeMigration' }));
    if (streamMode === 'full') {
      const live = allTokens().filter(t => t.gated !== false && t.dex === 'pumpfun' && t.state !== 'DEAD').map(t => t.ca);
      for (let index = 0; index < live.length; index += 50)
        ws!.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: live.slice(index, index + 50) }));
      console.log(`[pumpfun] connected — resubscribed ${live.length} live token streams`);
    } else console.log('[pumpfun] connected, subscribed to new tokens + migrations');
  });

  ws.on('message', (raw: WebSocket.RawData) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.mint && msg.txType === 'create') {
        const fail = prefilter(msg);
        const t = addToken({ ca: msg.mint, symbol: msg.symbol || '?', name: msg.name || '?', creator: msg.traderPublicKey || null, source: 'pumpfun' });
        if (t && fail) {
          t.gated = false;
          t.gateFailReason = fail;
          seedCurve(t, msg);
          if (t.firstScorePrice === null && t.priceUsd > 0) t.firstScorePrice = t.priceUsd;
          recordScan({ ca: t.ca, symbol: t.symbol, verdict: 'KILL', reason: fail, at: Date.now() });
          upsertToken(t).catch(() => {});
        } else if (t) {
          seedCurve(t, msg);
          fetchSocials(t, msg.uri);
          if (t.creator) bumpDeployer(t.creator);
          if (streamMode === 'full') ws!.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [msg.mint] }));
          onNew(t.ca);
        }
      } else if (msg.mint && (msg.txType === 'buy' || msg.txType === 'sell')) {
        applyCurveTrade(msg);
      } else if (msg.mint && (msg.txType === 'migrate' || msg.txType === 'migration')) {
        const t = getToken(msg.mint);
        if (t) {
          t.dex = 'pumpswap'; t.dexId = 'pumpswap'; t.playType = 'GRADUATION';
          t.gradAt = Date.now(); t.gradPeak = t.priceUsd || 0; t.gradTrough = t.priceUsd || 0;
          if (t.firstSeen) t.fillMinutes = Math.round((Date.now() - t.firstSeen) / 60_000);
          console.log(`[pumpfun] 🎓 GRADUATED $${t.symbol} -> PumpSwap (fill ${t.fillMinutes}m)`);
        }
      }
    } catch {}
  });
  ws.on('close', () => reconnect(onNew));
  ws.on('error', error => { console.error('[pumpfun] ws error:', error.message); ws?.close(); });
}

export function unsubscribeToken(ca: string) { try { ws?.send(JSON.stringify({ method: 'unsubscribeTokenTrade', keys: [ca] })); } catch {} }
export function resubscribeAll() {
  if (streamMode !== 'full' || !ws || ws.readyState !== ws.OPEN) return 0;
  const live = allTokens().filter(t => t.gated !== false && t.dex === 'pumpfun' && t.state !== 'DEAD').map(t => t.ca);
  for (let index = 0; index < live.length; index += 50)
    try { ws.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: live.slice(index, index + 50) })); } catch {}
  return live.length;
}
export function startSubscriptionReconciler() {
  setInterval(() => {
    if (streamMode !== 'full' || !ws || ws.readyState !== ws.OPEN) return;
    const now = Date.now();
    const stale = allTokens().filter(t => t.gated !== false && t.dex === 'pumpfun' && t.state !== 'DEAD'
      && (!t.recentTrades.length || now - t.recentTrades[t.recentTrades.length - 1].at > 4 * 60_000)).map(t => t.ca);
    if (!stale.length) return;
    for (let index = 0; index < stale.length; index += 50)
      try { ws!.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: stale.slice(index, index + 50) })); } catch {}
    console.log(`[pumpfun] reconciler re-subscribed ${stale.length} stale-trade tokens`);
  }, 2 * 60_000);
}
export function subscribeToken(ca: string) { if (streamMode === 'full') try { ws?.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [ca] })); } catch {} }
function reconnect(onNew: (ca: string) => void) {
  console.log(`[pumpfun] reconnecting in ${backoff}ms`);
  setTimeout(() => connect(onNew), backoff);
  backoff = Math.min(backoff * 2, 60_000);
}
