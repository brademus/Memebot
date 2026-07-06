"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.activeWalletCount = void 0;
exports.startWalletTracker = startWalletTracker;
const config_1 = require("../config");
const db_1 = require("../db");
const store_1 = require("../store");
// Smart-money wallet tracker.
// Polls each active wallet's recent txs via Helius enhanced API; a SWAP that acquires
// a token becomes a smart_money_hit on that token (and a discovery source if unseen).
// Anti-dust-poisoning: only tx.type === 'SWAP' counts — plain transfers are ignored,
// so dusting a famous wallet with a fake token can't trigger a hit.
let wallets = [];
const seenSigs = new Set();
const activeWalletCount = () => wallets.length;
exports.activeWalletCount = activeWalletCount;
function startWalletTracker() {
    refreshList();
    setInterval(refreshList, 5 * 60_000);
    const tick = async () => {
        if (config_1.env.HELIUS_API_KEY && wallets.length) {
            for (const w of wallets)
                await pollWallet(w).catch(() => { });
        }
        setTimeout(tick, (0, config_1.cfg)().wallets.poll_interval_ms);
    };
    tick();
}
async function refreshList() {
    if (!db_1.pool)
        return;
    const r = await db_1.pool.query(`SELECT wallet FROM smart_wallets WHERE active = TRUE`).catch(() => null);
    if (r)
        wallets = r.rows.map(x => x.wallet);
}
async function pollWallet(wallet) {
    const res = await fetch(`https://api.helius.xyz/v0/addresses/${wallet}/transactions?api-key=${config_1.env.HELIUS_API_KEY}&limit=15`);
    if (!res.ok)
        return;
    const txs = await res.json();
    for (const tx of txs) {
        if (seenSigs.has(tx.signature))
            continue;
        seenSigs.add(tx.signature);
        if (seenSigs.size > 20_000)
            seenSigs.clear(); // crude memory cap
        if (tx.type !== 'SWAP')
            continue; // dust-poisoning filter
        for (const tt of tx.tokenTransfers || []) {
            if (tt.toUserAccount !== wallet || !tt.mint)
                continue;
            if (tt.mint === 'So11111111111111111111111111111111111111112')
                continue;
            let t = (0, store_1.getToken)(tt.mint);
            if (!t) {
                // smart wallet bought something we haven't seen — that's a discovery source
                t = (0, store_1.addToken)({ ca: tt.mint, symbol: '?', name: 'wallet-discovered', creator: null, source: 'wallet' }) || undefined;
            }
            if (t) {
                t.smartHits.push({ wallet, at: (tx.timestamp ? tx.timestamp * 1000 : Date.now()) });
                console.log(`[wallets] hit ${wallet.slice(0, 6)}… bought ${tt.mint.slice(0, 8)}…`);
            }
        }
    }
}
