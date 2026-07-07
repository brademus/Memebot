import WebSocket from 'ws';
import { addToken, getToken } from '../store';
import { bumpDeployer } from '../db';

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
  // dev's initial buy counts as first buy pressure
  if (msg.initialBuy || msg.solAmount) t.buys5m = 1;
}

function applyCurveTrade(msg: any) {
  const t = getToken(msg.mint);
  if (!t) return;
  // keep curve reserves fresh so liquidity/mcap track reality pre-graduation
  if (msg.vSolInBondingCurve) { t.curveSol = msg.vSolInBondingCurve; t.liquidityUsd = msg.vSolInBondingCurve * SOL_USD; }
  if (msg.marketCapSol) t.mcapUsd = msg.marketCapSol * SOL_USD;
  if (msg.txType === 'buy') { t.buys5m++; t.uniqueBuyerSamples.push(t.buys5m); if (t.uniqueBuyerSamples.length > 6) t.uniqueBuyerSamples.shift(); }
  else if (msg.txType === 'sell') t.sells5m++;
  // update price from curve: price per token ≈ (SOL reserve / token reserve) * SOL_USD
  if (msg.vSolInBondingCurve && msg.vTokensInBondingCurve)
    t.priceUsd = (msg.vSolInBondingCurve / msg.vTokensInBondingCurve) * SOL_USD;
}

// PumpPortal free public websocket — the standard community feed for pump.fun new mints.
// If it dies, swap URL here; nothing downstream changes.
const WS_URL = 'wss://pumpportal.fun/api/data';
let ws: WebSocket | null = null;
let backoff = 1000;

export function startPumpfunMonitor(onNew: (ca: string) => void) {
  connect(onNew);
}

function connect(onNew: (ca: string) => void) {
  ws = new WebSocket(WS_URL);

  ws.on('open', () => {
    backoff = 1000;
    ws!.send(JSON.stringify({ method: 'subscribeNewToken' }));
    console.log('[pumpfun] connected, subscribed to new tokens');
  });

  ws.on('message', (raw: WebSocket.RawData) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.mint && msg.txType === 'create') {
        const t = addToken({
          ca: msg.mint,
          symbol: msg.symbol || '?',
          name: msg.name || '?',
          creator: msg.traderPublicKey || null,
          source: 'pumpfun',
        });
        if (t) {
          // seed curve liquidity/mcap from the create event so the gate can run
          // IMMEDIATELY, without waiting for Dexscreener to index the token
          seedCurve(t, msg);
          if (t.creator) bumpDeployer(t.creator);
          // subscribe to this token's trades to track real curve buy pressure
          ws!.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [msg.mint] }));
          onNew(t.ca);
        }
      } else if (msg.mint && (msg.txType === 'buy' || msg.txType === 'sell')) {
        // live curve trade — update buy/sell counts and curve reserves
        applyCurveTrade(msg);
      }
    } catch { /* ignore malformed frames */ }
  });

  ws.on('close', () => reconnect(onNew));
  ws.on('error', (e) => { console.error('[pumpfun] ws error:', e.message); ws?.close(); });
}

function reconnect(onNew: (ca: string) => void) {
  console.log(`[pumpfun] reconnecting in ${backoff}ms`);
  setTimeout(() => connect(onNew), backoff);
  backoff = Math.min(backoff * 2, 60_000);
}
