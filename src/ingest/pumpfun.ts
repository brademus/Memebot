import WebSocket from 'ws';
import { addToken, getToken, allTokens, recordScan } from '../store';
import { bumpDeployer, upsertToken } from '../db';
import { prefilter } from '../gates/prefilter';
import { env } from '../config';
import { fetchSocials } from './metadata';

// SOL price proxy for converting curve SOL -> USD. Refreshed opportunistically; a
// rough constant is fine for gating thresholds (we care about magnitude, not cents).
let SOL_USD = 150;
export function setSolPrice(p: number) { if (p > 0) SOL_USD = p; }
export const getSolPrice = () => SOL_USD;

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
    // CRITICAL: re-subscribe the per-token trade streams for everything we're
    // already tracking. Without this, any ws drop (constant on public feeds)
    // silently starved every live token: buys5m decayed to zero in 5 minutes,
    // scores collapsed, and nothing could trigger — while the feed LOOKED alive
    // because new mints kept arriving.
    if (streamMode === 'full') {
      const live = allTokens()
        .filter(t => t.gated !== false && t.dex === 'pumpfun' && t.state !== 'DEAD')
        .map(t => t.ca);
      for (let i = 0; i < live.length; i += 50)   // batch keys to keep frames small
        ws!.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: live.slice(i, i + 50) }));
      console.log(`[pumpfun] connected — resubscribed ${live.length} live token streams`);
    } else {
      console.log('[pumpfun] connected, subscribed to new tokens + migrations');
    }
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
          t.gradAt = Date.now();
          t.gradPeak = t.priceUsd || 0;
          t.gradTrough = t.priceUsd || 0;
          if (t.firstSeen) t.fillMinutes = Math.round((Date.now() - t.firstSeen) / 60_000);
          console.log(`[pumpfun] 🎓 GRADUATED $${t.symbol} -> PumpSwap (fill ${t.fillMinutes}m)`);
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

// Subscribe a token surfaced by another engine (wallet webhook / momentum scanner)
// to the curve trade stream. Without this, surfaced pre-graduation tokens never
// accumulated buy/sell counts or curve samples and scored ~0 organic forever.
// Re-subscribe every live curve token's trade stream. Called after warm-boot
// hydration (restored tokens were inserted AFTER the socket opened, so they had
// no trade feed — the exact cause of fresh-ish coins showing 0 buys/0 sells and
// scores that can't clear the floor) and periodically to heal any silently-lapsed
// per-token subscription without waiting for a full ws reconnect.
export function resubscribeAll() {
  if (streamMode !== 'full' || !ws || ws.readyState !== ws.OPEN) return 0;
  const live = allTokens()
    .filter(t => t.gated !== false && t.dex === 'pumpfun' && t.state !== 'DEAD')
    .map(t => t.ca);
  for (let i = 0; i < live.length; i += 50)
    try { ws.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: live.slice(i, i + 50) })); } catch {}
  return live.length;
}

// Reconciliation: a live curve token that hasn't logged a trade in >4min almost
// certainly has a lapsed subscription (a genuinely dead coin gets pruned to DEAD).
// Re-subscribe those specifically. Runs every 2min.
export function startSubscriptionReconciler() {
  setInterval(() => {
    if (streamMode !== 'full' || !ws || ws.readyState !== ws.OPEN) return;
    const now = Date.now();
    const stale = allTokens().filter(t =>
      t.gated !== false && t.dex === 'pumpfun' && t.state !== 'DEAD' &&
      (!t.recentTrades.length || now - t.recentTrades[t.recentTrades.length - 1].at > 4 * 60_000)
    ).map(t => t.ca);
    if (!stale.length) return;
    for (let i = 0; i < stale.length; i += 50)
      try { ws!.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: stale.slice(i, i + 50) })); } catch {}
    console.log(`[pumpfun] reconciler re-subscribed ${stale.length} stale-trade tokens`);
  }, 2 * 60_000);
}

export function subscribeToken(ca: string) {
  if (streamMode !== 'full') return;
  try { ws?.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [ca] })); } catch {}
}

function reconnect(onNew: (ca: string) => void) {
  console.log(`[pumpfun] reconnecting in ${backoff}ms`);
  setTimeout(() => connect(onNew), backoff);
  backoff = Math.min(backoff * 2, 60_000);
}
