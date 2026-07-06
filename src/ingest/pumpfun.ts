import WebSocket from 'ws';
import { addToken } from '../store';
import { bumpDeployer } from '../db';

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
          if (t.creator) bumpDeployer(t.creator);
          onNew(t.ca);
        }
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
