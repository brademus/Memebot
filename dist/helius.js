"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.heliusTxs = heliusTxs;
exports.earlyBuyers = earlyBuyers;
const config_1 = require("./config");
// Shared Helius helpers. Enhanced-transactions API returns parsed token/native transfers.
async function heliusTxs(address, limit = 100) {
    if (!config_1.env.HELIUS_API_KEY)
        return [];
    try {
        const res = await fetch(`https://api.helius.xyz/v0/addresses/${address}/transactions?api-key=${config_1.env.HELIUS_API_KEY}&limit=${limit}`);
        if (!res.ok)
            return [];
        const data = await res.json();
        return Array.isArray(data) ? data : [];
    }
    catch {
        return [];
    }
}
// Earliest buyers of a mint: wallets that received the token in its first N slots.
async function earlyBuyers(mint, slotWindow = 3) {
    const txs = await heliusTxs(mint, 100);
    if (!txs.length)
        return [];
    const minSlot = Math.min(...txs.map((t) => t.slot));
    const buyers = new Set();
    for (const tx of txs) {
        if (tx.slot > minSlot + slotWindow)
            continue;
        for (const tt of tx.tokenTransfers || []) {
            if (tt.mint === mint && tt.toUserAccount)
                buyers.add(tt.toUserAccount);
        }
    }
    return [...buyers];
}
