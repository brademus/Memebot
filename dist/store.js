"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.recentScans = exports.pendingGate = exports.activeTokens = exports.allTokens = exports.getToken = void 0;
exports.addToken = addToken;
exports.removeToken = removeToken;
exports.recordScan = recordScan;
const config_1 = require("./config");
// In-memory hot store. Postgres is the durable log; this is the live watchlist.
const tokens = new Map();
function addToken(partial) {
    if (tokens.has(partial.ca))
        return null;
    if (tokens.size >= (0, config_1.cfg)().limits.max_tracked_tokens)
        evictOldest();
    const t = {
        ...partial,
        firstSeen: Date.now(),
        priceUsd: 0, liquidityUsd: 0, mcapUsd: 0, vol5m: 0, buys5m: 0, sells5m: 0, priceChange5m: 0,
        pairAddress: null, dex: null, dexId: null,
        gated: null, gateFailReason: null, bundle: null, aiNote: null, smartHits: [], ai: null,
        score: 0, peakScore: 0, firstScorePrice: null,
        subs: { freshness: 0, liquidity: 0, buyPressure: 0, holderGrowth: 0, smartMoney: 0 },
        uniqueBuyerSamples: [],
        state: 'PENDING', stateChangedAt: Date.now(), lastAlertScore: 0,
    };
    tokens.set(t.ca, t);
    return t;
}
const getToken = (ca) => tokens.get(ca);
exports.getToken = getToken;
const allTokens = () => [...tokens.values()];
exports.allTokens = allTokens;
const activeTokens = () => (0, exports.allTokens)().filter(t => t.gated === true && t.state !== 'DEAD');
exports.activeTokens = activeTokens;
const pendingGate = () => (0, exports.allTokens)().filter(t => t.gated === null);
exports.pendingGate = pendingGate;
function removeToken(ca) { tokens.delete(ca); }
function evictOldest() {
    let oldest = null;
    for (const t of tokens.values())
        if (!oldest || t.firstSeen < oldest.firstSeen)
            oldest = t;
    if (oldest)
        tokens.delete(oldest.ca);
}
const scans = [];
function recordScan(e) {
    scans.unshift(e);
    if (scans.length > 200)
        scans.pop();
}
const recentScans = () => scans;
exports.recentScans = recentScans;
