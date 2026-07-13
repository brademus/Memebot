import { cfg, env } from '../config';
import { pool } from '../db';
import { getToken } from '../store';
import { heliusTxs } from '../helius';
import { webhookLive } from './webhook';
import { recordWalletEntry, startWalletOutcomeLedger } from './ledger';

const recentHits = new Map<string, number>();
let activeCount = 0;
export const walletsTracked = () => activeCount > 0 || webhookLive();

const walletWinners = new Map<string, number>();
export function setWalletWeights(rows: { wallet: string; winners_hit: number }[]) {
  for (const row of rows) walletWinners.set(row.wallet, Number(row.winners_hit) || 0);
}
export function walletWeight(wallet: string): number {
  const settings = cfg().wallets;
  return (walletWinners.get(wallet) || 0) >= settings.elite_min_winners ? settings.elite_weight : 1;
}
export function weightedSmartHits(hits: { wallet: string; at: number; w: number }[], windowMs: number, now = Date.now()) {
  const seen = new Map<string, number>();
  for (const hit of hits) if (now - hit.at < windowMs) seen.set(hit.wallet, Math.max(seen.get(hit.wallet) || 0, hit.w || 1));
  let weight = 0, elite = 0;
  for (const value of seen.values()) { weight += value; if (value > 1) elite++; }
  return { wallets: seen.size, weight, elite };
}

export function recordSmartBuy(
  wallet: string,
  ca: string,
  onDiscovery: (ca: string) => void,
  signal = true,
  atMs = Date.now(),
) {
  if (signal) recentHits.set(ca, atMs);
  let token = getToken(ca);
  if (!token) {
    onDiscovery(ca);
    token = getToken(ca);
  }
  recordWalletEntry(wallet, ca, atMs, token?.priceUsd || null).catch(() => {});
  if (pool) pool.query(`UPDATE smart_wallets SET last_active=to_timestamp($2/1000.0) WHERE wallet=$1`, [wallet, atMs]).catch(() => {});
  if (!signal) return;

  const weight = walletWeight(wallet);
  if (token) {
    const prior = token.smartHits.find(hit => hit.wallet === wallet);
    if (prior) { prior.at = atMs; prior.w = weight; }
    else {
      token.smartHits.push({ wallet, at: atMs, w: weight });
      if (token.smartHits.length > 100) token.smartHits.shift();
      if (weight > 1) console.log(`[wallets] ◆ ELITE buy: ${wallet.slice(0, 4)}…(${walletWinners.get(wallet)} winners) -> $${token.symbol}`);
    }
  }
}

export function startWalletTracker(onDiscovery: (ca: string) => void) {
  startWalletOutcomeLedger();
  if (!cfg().wallets.enabled || !env.HELIUS_API_KEY || !pool) return;
  const tick = async () => {
    await pollOnce(onDiscovery);
    setTimeout(tick, 30_000);
  };
  setTimeout(tick, 120_000);
}

async function pollOnce(onDiscovery: (ca: string) => void) {
  if (!pool) return;
  const hitCutoff = Date.now() - 24 * 3600_000;
  for (const [ca, at] of recentHits) if (at < hitCutoff) recentHits.delete(ca);
  if (webhookLive()) { activeCount = 0; return; }
  try {
    const active = await pool.query(
      `SELECT wallet,winners_hit FROM smart_wallets WHERE active
       ORDER BY winners_hit DESC,last_validated DESC LIMIT 40`);
    activeCount = active.rows.length;
    setWalletWeights(active.rows);
    const quotes = new Set([
      'So11111111111111111111111111111111111111112',
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    ]);
    for (const { wallet } of active.rows) {
      const txs = await heliusTxs(wallet, 10);
      for (const tx of txs) {
        const atMs = tx.timestamp ? tx.timestamp * 1000 : Date.now();
        if (Date.now() - atMs > 10 * 60_000) continue;
        if (tx.type && tx.type !== 'SWAP') continue;
        for (const transfer of tx.tokenTransfers || []) {
          if (transfer.toUserAccount !== wallet || !transfer.mint || quotes.has(transfer.mint)) continue;
          recordSmartBuy(wallet, transfer.mint, onDiscovery, true, atMs);
        }
      }
    }
  } catch (error) { console.error('[wallets] tracker', (error as Error).message); }
}

export async function smartMoneyHits(ca: string): Promise<number> {
  if (!pool) return 0;
  const hours = cfg().wallets.hit_recency_hours;
  const result = await pool.query(
    `SELECT COUNT(DISTINCT wallet)::int c FROM wallet_hits
      WHERE ca=$1 AND buy_at > now()-($2||' hours')::interval`,
    [ca, String(hours)],
  ).catch(() => null);
  return result?.rows[0]?.c || 0;
}
