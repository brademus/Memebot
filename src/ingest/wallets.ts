import { cfg, env } from '../config';
import { pool } from '../db';
import { addToken, getToken } from '../store';

// Smart-money wallet tracker.
// Polls each active wallet's recent txs via Helius enhanced API; a SWAP that acquires
// a token becomes a smart_money_hit on that token (and a discovery source if unseen).
// Anti-dust-poisoning: only tx.type === 'SWAP' counts — plain transfers are ignored,
// so dusting a famous wallet with a fake token can't trigger a hit.

let wallets: string[] = [];
const seenSigs = new Set<string>();

export const activeWalletCount = () => wallets.length;

export function startWalletTracker() {
  refreshList();
  setInterval(refreshList, 5 * 60_000);
  const tick = async () => {
    if (env.HELIUS_API_KEY && wallets.length) {
      for (const w of wallets) await pollWallet(w).catch(() => {});
    }
    setTimeout(tick, cfg().wallets.poll_interval_ms);
  };
  tick();
}

async function refreshList() {
  if (!pool) return;
  const r = await pool.query(`SELECT wallet FROM smart_wallets WHERE active = TRUE`).catch(() => null);
  if (r) wallets = r.rows.map(x => x.wallet);
}

async function pollWallet(wallet: string) {
  const res = await fetch(
    `https://api.helius.xyz/v0/addresses/${wallet}/transactions?api-key=${env.HELIUS_API_KEY}&limit=15`);
  if (!res.ok) return;
  const txs: any[] = await res.json();
  for (const tx of txs) {
    if (seenSigs.has(tx.signature)) continue;
    seenSigs.add(tx.signature);
    if (seenSigs.size > 20_000) seenSigs.clear();          // crude memory cap
    if (tx.type !== 'SWAP') continue;                      // dust-poisoning filter
    for (const tt of tx.tokenTransfers || []) {
      if (tt.toUserAccount !== wallet || !tt.mint) continue;
      if (tt.mint === 'So11111111111111111111111111111111111111112') continue;
      let t = getToken(tt.mint);
      if (!t) {
        // smart wallet bought something we haven't seen — that's a discovery source
        t = addToken({ ca: tt.mint, symbol: '?', name: 'wallet-discovered', creator: null, source: 'wallet' }) || undefined as any;
      }
      if (t) {
        t.smartHits.push({ wallet, at: (tx.timestamp ? tx.timestamp * 1000 : Date.now()) });
        console.log(`[wallets] hit ${wallet.slice(0, 6)}… bought ${tt.mint.slice(0, 8)}…`);
      }
    }
  }
}
