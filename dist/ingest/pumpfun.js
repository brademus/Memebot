"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startPumpfunMonitor = startPumpfunMonitor;
const ws_1 = __importDefault(require("ws"));
const store_1 = require("../store");
const db_1 = require("../db");
// PumpPortal free public websocket — the standard community feed for pump.fun new mints.
// If it dies, swap URL here; nothing downstream changes.
const WS_URL = 'wss://pumpportal.fun/api/data';
let ws = null;
let backoff = 1000;
function startPumpfunMonitor(onNew) {
    connect(onNew);
}
function connect(onNew) {
    ws = new ws_1.default(WS_URL);
    ws.on('open', () => {
        backoff = 1000;
        ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
        console.log('[pumpfun] connected, subscribed to new tokens');
    });
    ws.on('message', (raw) => {
        try {
            const msg = JSON.parse(raw.toString());
            if (msg.mint && msg.txType === 'create') {
                const t = (0, store_1.addToken)({
                    ca: msg.mint,
                    symbol: msg.symbol || '?',
                    name: msg.name || '?',
                    creator: msg.traderPublicKey || null,
                    source: 'pumpfun',
                });
                if (t) {
                    if (t.creator)
                        (0, db_1.bumpDeployer)(t.creator);
                    onNew(t.ca);
                }
            }
        }
        catch { /* ignore malformed frames */ }
    });
    ws.on('close', () => reconnect(onNew));
    ws.on('error', (e) => { console.error('[pumpfun] ws error:', e.message); ws?.close(); });
}
function reconnect(onNew) {
    console.log(`[pumpfun] reconnecting in ${backoff}ms`);
    setTimeout(() => connect(onNew), backoff);
    backoff = Math.min(backoff * 2, 60_000);
}
