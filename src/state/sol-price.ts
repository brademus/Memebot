/**
 * Single source of SOL/USD for sizing decisions. Fed by the index price poller via
 * pumpfun.setSolPrice (kept for caller compatibility). getSolUsd() returns 0 when
 * no live price has arrived yet — consumers must handle unknown explicitly.
 */
let solUsd = 0;
let updatedAt = 0;
export function setSolUsd(price: number) { if (price > 0) { solUsd = price; updatedAt = Date.now(); } }
export const getSolUsd = () => solUsd;
export const solPriceAgeMs = () => (updatedAt ? Date.now() - updatedAt : Number.POSITIVE_INFINITY);
