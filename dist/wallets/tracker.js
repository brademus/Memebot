"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.walletsTracked = void 0;
exports.startWalletTracker = startWalletTracker;
exports.smartMoneyHits = smartMoneyHits;
const config_1 = require("../config");
const db_1 = require("../db");
const store_1 = require("../store");
const helius_1 = require("../helius");
// LIVE WALLET WATCH — polls active tracked wallets for recent buys.
const recentHits = new Map();
let activeCount = 0;
const walletsTracked = () => activeCount > 0;
exports.walletsTracked = walletsTracked;
function startWalletTracker(onDiscovery) {
    if (!(0, config_1.cfg)().wallets.enabled || !config_1.env.HELIUS_API_KEY || !db_1.pool)
        return;
    const tick = async () => {
        await pollOnce(onDiscovery);
        setTimeout(tick, 30_000);
    };
    setTimeout(tick, 120_000);
}
async function pollOnce(onDiscovery) {
    if (!db_1.pool)
        return;
    try {
        const active = await db_1.pool.query(`SELECT wallet FROM smart_wallets WHERE active ORDER BY last_validated DESC LIMIT 40`);
        activeCount = active.rows.length;
        for (const { wallet } of active.rows) {
            const txs = await (0, helius_1.heliusTxs)(wallet, 10);
            for (const tx of txs) {
                const age = Date.now() - (tx.timestamp ? tx.timestamp * 1000 : Date.now());
                if (age > 10 * 60_000)
                    continue;
                if (tx.type && tx.type !== 'SWAP')
                    continue; // anti-dust: only real swaps, not transfers
                for (const tt of tx.tokenTransfers || []) {
                    if (tt.toUserAccount !== wallet || !tt.mint)
                        continue;
                    const ca = tt.mint;
                    recentHits.set(ca, Date.now());
                    await db_1.pool.query(`INSERT INTO wallet_hits (ca, wallet) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [ca, wallet]).catch(() => { });
                    const existing = (0, store_1.getToken)(ca);
                    if (existing) {
                        if (!existing.smartHits.some(h => h.wallet === wallet))
                            existing.smartHits.push({ wallet, at: Date.now() });
                    }
                    else {
                        onDiscovery(ca);
                    }
                }
            }
        }
    }
    catch (e) {
        console.error('[wallets] tracker', e.message);
    }
}
async function smartMoneyHits(ca) {
    if (!db_1.pool)
        return 0;
    const hours = (0, config_1.cfg)().wallets.hit_recency_hours;
    const r = await db_1.pool.query(`SELECT COUNT(DISTINCT wallet)::int c FROM wallet_hits
     WHERE ca = $1 AND at > now() - ($2 || ' hours')::interval`, [ca, String(hours)]).catch(() => null);
    return r?.rows[0]?.c || 0;
}
