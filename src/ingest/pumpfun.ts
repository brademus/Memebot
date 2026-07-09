import WebSocket from 'ws';
import { addToken, getToken, recordScan } from '../store';
import { bumpDeployer, upsertToken } from '../db';
import { prefilter } from '../gates/prefilter';
import { env } from '../config';
import { fetchSocials } from './metadata';

// SOL price proxy for converting curve SOL -> USD. Refreshed opportunistically; a
// rough constant is fine for gating thresholds (we care about magnitude, not cents).
let SOL_USD = 150;
export function setSolPrice(p: number) { if (p > 0) SOL_USD = p; }

function seedCurve(t: any, msg: any) {
  const solInCurve = msg.vSolInBondingCurve || 0;
  const mcapSol = msg.marketCapSol || 0;
  t.curveSol = solInCurve;
  // bonding-curve liquidity ≈ SOL locked in the curve (both sides are the curve)
  t.liquidityUsd = solInCurve * SOL_USD;
  t.mcapUsd = mcapSol * SOL_USD;
  t.dex = 'pumpfun';
  t.dexId = 'pumpfun';
  // dev's initial buy counts as first buy pressure + record its size (big dev bag = risk)
  if (msg.initialBuy || msg.solAmount) t.buys5m = 1;
  if (msg.initialBuy) t.devBuyPct = Math.min(100, (msg.initialBuy / 1e9) * 100);   // pump.fun supply = 1B
  t.curveSamples = [{ sol: solInCurve, at: Date.now() }];
}

function applyCurveTrade(msg: any) {
  const t = getToken(msg.mint);
  if (!t) return;
  // keep curve reserves fresh so liquidity/mcap track reality pre-graduation
  if (msg.vSolInBondingCurve) {
    t.curveSol = msg.vSolInBondingCurve;
    t.peakCurveSol = Math.max(t.peakCurveSol, t.curveSol);
    t.liquidityUsd = msg.vSolInBondingCurve * SOL_USD;
  }
  if (msg.marketCapSol) t.mcapUsd = msg.marketCapSol * SOL_USD;
  if (msg.txType === 'buy') {
    t.totalBuys++;
    t.recentTrades.push({ at: Date.now(), buy: true });
    // distinct buyer wallets — the real organic-demand signal (capped to bound memory)
    const buyer = msg.traderPublicKey;
    if (buyer && !t.uniqueBuyers.includes(buyer) && t.uniqueBuyers.length < 500) t.uniqueBuyers.push(buyer);
    // the snipe cohort: first 15 distinct buyers — research: 85% of snipers exit within 5 min,
    // so whether THESE wallets hold or dump is the burst-vs-real discriminator
    if (buyer && t.earlyBuyers.length < 15 && !t.earlyBuyers.includes(buyer)) t.earlyBuyers.push(buyer);
  } else if (msg.txType === 'sell') {
    t.totalSells++;
    t.recentTrades.push({ at: Date.now(), buy: false });
    const seller = msg.traderPublicKey;
    if (seller && t.earlyBuyers.includes(seller) && !t.earlyExited.includes(seller)) t.earlyExited.push(seller);
  }
  // maintain REAL 5-minute counters from the rolling window (curve tokens only —
  // Dexscreener overwrites these with its own 5m data once an AMM pair exists)
  const cutoff = Date.now() - 5 * 60_000;
  while (t.recentTrades.length && t.recentTrades[0].at < cutoff) t.recentTrades.shift();
  if (t.dex === 'pumpfun') {
    t.buys5m = t.recentTrades.filter(x => x.buy).length;
    t.sells5m = t.recentTrades.length - t.buys5m;
  }
  // unique-buyer sample now tracks the windowed count
  if (msg.txType === 'buy') {
    t.uniqueBuyerSamples.push(t.buys5m);
    if (t.uniqueBuyerSamples.length > 6) t.uniqueBuyerSamples.shift();
  }
  // rolling curve-SOL history for demand velocity (keep ~3 min of samples)
  t.curveSamples.push({ sol: t.curveSol, at: Date.now() });
  if (t.curveSamples.length > 60) t.curveSamples.shift();
  // update price from curve: price per token ≈ (SOL reserve / token reserve) * SOL_USD
  if (msg.vSolInBondingCurve && msg.vTokensInBondingCurve)
    t.priceUsd = (msg.vSolInBondingCurve / msg.vTokensInBondingCurve) * SOL_USD;
}

// PumpPortal free public websocket — the standard community feed for pump.fun new mints.
// If it dies, swap URL here; nothing downstream changes.
const WS_URL = () => 'wss://pumpportal.fun/api/data' + (env.PUMPPORTAL_API_KEY ? `?api-key=${env.PUMPPORTAL_API_KEY}` : '');

// FULL = per-trade stream live (funded PumpPortal key). LITE = free tier; per-trade
// signals unavailable, scoring/floors auto-switch to Dexscreener-derived proxies.
let streamMode: 'full' | 'lite' = env.PUMPPORTAL_API_KEY ? 'full' : 'lite';
export const getStreamMode = () => streamMode;
let ws: WebSocket | null = null;
let backoff = 1000;

export function startPumpfunMonitor(onNew: (ca: string) => void) {
  connect(onNew);
}

function connect(onNew: (ca: string) => void) {
  ws = new WebSocket(WS_URL());

  ws.on('open', () => {
    backoff = 1000;
    ws!.send(JSON.stringify({ method: 'subscribeNewToken' }));
    ws!.send(JSON.stringify({ method: 'subscribeMigration' }));
    console.log('[pumpfun] connected, subscribed to new tokens + migrations');
  });

  ws.on('message', (raw: WebSocket.RawData) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.mint && msg.txType === 'create') {
        // PREFILTER: zero-API kills before we spend ANYTHING on this mint.
        // Killed mints are still recorded (seen feed stays honest) but get no
        // trade subscription, no metadata fetch, and never reach the gates.
        const pf = prefilter(msg);
        const t = addToken({
          ca: msg.mint,
          symbol: msg.symbol || '?',
          name: msg.name || '?',
          creator: msg.traderPublicKey || null,
          source: 'pumpfun',
        });
        if (t && pf) {
          t.gated = false;
          t.gateFailReason = pf;
          // seed the curve state anyway (free, from this same message) so the kill
          // gets a reference price — without it the outcome logger can't measure
          // whether this prefilter rule ever kills future winners, and the filter
          // learner would be flying blind on its own mistakes.
          seedCurve(t, msg);
          if (t.firstScorePrice === null && t.priceUsd > 0) t.firstScorePrice = t.priceUsd;
          recordScan({ ca: t.ca, symbol: t.symbol, verdict: 'KILL', reason: pf, at: Date.now() });
          upsertToken(t).catch(() => {});
        } else if (t) {
          // seed curve liquidity/mcap from the create event so the gate can run
          // IMMEDIATELY, without waiting for Dexscreener to index the token
          seedCurve(t, msg);
          fetchSocials(t, msg.uri);   // async — 17x-lift signal, resolves within seconds
          if (t.creator) bumpDeployer(t.creator);
          // subscribe to this token's trades to track real curve buy pressure
          if (streamMode === 'full') ws!.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [msg.mint] }));
          onNew(t.ca);
        }
      } else if (msg.mint && (msg.txType === 'buy' || msg.txType === 'sell')) {
        // live curve trade — update buy/sell counts and curve reserves
        applyCurveTrade(msg);
      } else if (msg.mint && (msg.txType === 'migrate' || msg.txType === 'migration')) {
        // token graduated -> PumpSwap. This is a distinct play type: proven demand,
        // but research warns most graduates retrace hard — flag, don't celebrate.
        const t = getToken(msg.mint);
        if (t) {
          t.dex = 'pumpswap'; t.dexId = 'pumpswap';
          t.playType = 'GRADUATION';
          console.log(`[pumpfun] 🎓 GRADUATED $${t.symbol} -> PumpSwap`);
        }
      }
    } catch { /* ignore malformed frames */ }
  });

  ws.on('close', () => reconnect(onNew));
  ws.on('error', (e) => { console.error('[pumpfun] ws error:', e.message); ws?.close(); });
}

export function unsubscribeToken(ca: string) {
  try { ws?.send(JSON.stringify({ method: 'unsubscribeTokenTrade', keys: [ca] })); } catch {}
}

function reconnect(onNew: (ca: string) => void) {
  console.log(`[pumpfun] reconnecting in ${backoff}ms`);
  setTimeout(() => connect(onNew), backoff);
  backoff = Math.min(backoff * 2, 60_000);
}
