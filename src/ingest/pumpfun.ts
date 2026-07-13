import WebSocket from 'ws';
import { addToken, getToken, allTokens, recordScan } from '../store';
import { bumpDeployer, upsertToken } from '../db';
import { prefilter } from '../gates/prefilter';
import { env } from '../config';
import { fetchSocials } from './metadata';

let SOL_USD = 150;
export function setSolPrice(p: number) { if (p > 0) SOL_USD = p; }
export const getSolPrice = () => SOL_USD;

function seedCurve(t: any, msg: any) {
  const solInCurve = msg.vSolInBondingCurve || 0;
  const mcapSol = msg.marketCapSol || 0;
  t.curveSol = solInCurve;
  t.liquidityUsd = solInCurve * SOL_USD;
  t.mcapUsd = mcapSol * SOL_USD;
  t.dex = 'pumpfun';
  t.dexId = 'pumpfun';
  if (msg.initialBuy || msg.solAmount) t.buys5m = 1;
  if (msg.initialBuy) t.devBuyPct = Math.min(100, (msg.initialBuy / 1e9) * 100);
  t.curveSamples = [{ sol: solInCurve, at: Date.now() }];
}

function applyCurveTrade(msg: any) {
  const t = getToken(msg.mint);
  if (!t) return;
  if (msg.vSolInBondingCurve) {
    t.curveSol = msg.vSolInBondingCurve;
    t.peakCurveSol = Math.max(t.peakCurveSol, t.curveSol);
    t.liquidityUsd = msg.vSolInBondingCurve * SOL_USD;
  }
  if (msg.marketCapSol) t.mcapUsd = msg.marketCapSol * SOL_USD;
  if (msg.txType === 'buy') {
    t.totalBuys++;
    t.recentTrades.push({ at: Date.now(), buy: true });
    const buyer = msg.traderPublicKey;
    if (buyer && !t.uniqueBuyers.includes(buyer) && t.uniqueBuyers.length < 500) t.uniqueBuyers.push(buyer);
    if (buyer && t.earlyBuyers.length < 15 && !t.earlyBuyers.includes(buyer)) t.earlyBuyers.push(buyer);
  } else if (msg.txType === 'sell') {
    t.totalSells++;
    t.recentTrades.push({ at: Date.now(), buy: false });
    const seller = msg.traderPublicKey;
    if (seller && t.earlyBuyers.includes(seller) && !t.earlyExited.includes(seller)) t.earlyExited.push(seller);
  }
  const cutoff = Date.now() - 5 * 60_000;
  while (t.recentTrades.length && t.recentTrades[0].at < cutoff) t.recentTrades.shift();
  if (t.dex === 'pumpfun') {
    t.buys5m = t.recentTrades.filter(x => x.buy).length;
    t.sells5m = t.recentTrades.length - t.buys5m;
  }
  // Sample distinct-wallet breadth, not raw buy count. Repeated bot churn from a
  // single wallet can no longer masquerade as organic holder growth.
  if (msg.txType === 'buy') {
    t.uniqueBuyerSamples.push(t.uniqueBuyers.length);
    if (t.uniqueBuyerSamples.length > 6) t.uniqueBuyerSamples.shift();
  }
  t.curveSamples.push({ sol: t.curveSol, at: Date.now() });
  if (t.curveSamples.length > 60) t.curveSamples.shift();
  if (msg.vSolInBondingCurve && msg.vTokensInBondingCurve)
    t.priceUsd = (msg.vSolInBondingCurve / msg.vTokensInBondingCurve) * SOL_USD;
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
      for (let i = 0; i < live.length; i += 50)
        ws!.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: live.slice(i, i + 50) }));
      console.log(`[pumpfun] connected — resubscribed ${live.length} live token streams`);
    } else console.log('[pumpfun] connected, subscribed to new tokens + migrations');
  });

  ws.on('message', (raw: WebSocket.RawData) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.mint && msg.txType === 'create') {
        const pf = prefilter(msg);
        const t = addToken({ ca: msg.mint, symbol: msg.symbol || '?', name: msg.name || '?', creator: msg.traderPublicKey || null, source: 'pumpfun' });
        if (t && pf) {
          t.gated = false;
          t.gateFailReason = pf;
          seedCurve(t, msg);
          if (t.firstScorePrice === null && t.priceUsd > 0) t.firstScorePrice = t.priceUsd;
          recordScan({ ca: t.ca, symbol: t.symbol, verdict: 'KILL', reason: pf, at: Date.now() });
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
          t.dex = 'pumpswap'; t.dexId = 'pumpswap';
          t.playType = 'GRADUATION';
          t.gradAt = Date.now();
          t.gradPeak = t.priceUsd || 0;
          t.gradTrough = t.priceUsd || 0;
          if (t.firstSeen) t.fillMinutes = Math.round((Date.now() - t.firstSeen) / 60_000);
          console.log(`[pumpfun] 🎓 GRADUATED $${t.symbol} -> PumpSwap (fill ${t.fillMinutes}m)`);
        }
      }
    } catch {}
  });
  ws.on('close', () => reconnect(onNew));
  ws.on('error', (e) => { console.error('[pumpfun] ws error:', e.message); ws?.close(); });
}

export function unsubscribeToken(ca: string) { try { ws?.send(JSON.stringify({ method: 'unsubscribeTokenTrade', keys: [ca] })); } catch {} }
export function resubscribeAll() {
  if (streamMode !== 'full' || !ws || ws.readyState !== ws.OPEN) return 0;
  const live = allTokens().filter(t => t.gated !== false && t.dex === 'pumpfun' && t.state !== 'DEAD').map(t => t.ca);
  for (let i = 0; i < live.length; i += 50)
    try { ws.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: live.slice(i, i + 50) })); } catch {}
  return live.length;
}
export function startSubscriptionReconciler() {
  setInterval(() => {
    if (streamMode !== 'full' || !ws || ws.readyState !== ws.OPEN) return;
    const now = Date.now();
    const stale = allTokens().filter(t => t.gated !== false && t.dex === 'pumpfun' && t.state !== 'DEAD' && (!t.recentTrades.length || now - t.recentTrades[t.recentTrades.length - 1].at > 4 * 60_000)).map(t => t.ca);
    if (!stale.length) return;
    for (let i = 0; i < stale.length; i += 50)
      try { ws!.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: stale.slice(i, i + 50) })); } catch {}
    console.log(`[pumpfun] reconciler re-subscribed ${stale.length} stale-trade tokens`);
  }, 2 * 60_000);
}
export function subscribeToken(ca: string) { if (streamMode === 'full') try { ws?.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [ca] })); } catch {} }
function reconnect(onNew: (ca: string) => void) {
  console.log(`[pumpfun] reconnecting in ${backoff}ms`);
  setTimeout(() => connect(onNew), backoff);
  backoff = Math.min(backoff * 2, 60_000);
}
