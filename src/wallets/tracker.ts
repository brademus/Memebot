import { cfg, env } from '../config';
import { pool } from '../db';
import { getToken } from '../store';
import { heliusTxs } from '../helius';
import { webhookLive } from './webhook';

// LIVE WALLET WATCH.
// Primary path is the Helius webhook (see webhook.ts) — every active wallet
// streamed in real time. This poller is the FALLBACK for environments without a
// public URL: 40 wallets x 30s, the old ceiling. It stands down automatically
// once the webhook reports live so we don't double-spend API credits.
const recentHits = new Map<string, number>();
let activeCount = 0;
export const walletsTracked = () => activeCount > 0 || webhookLive();

// shared hit recorder — used by BOTH the poller and the webhook
export function recordSmartBuy(wallet: string, ca: string, onDiscovery: (ca: string) => void) {
  recentHits.set(ca, Date.now());
  if (pool) pool.query(
    `INSERT INTO wallet_hits (ca, wallet) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
    [ca, wallet]).catch(() => {});
  const existing = getToken(ca);
  if (existing) {
    if (!existing.smartHits.some(h => h.wallet === wallet))
      existing.smartHits.push({ wallet, at: Date.now() });
  } else {
    onDiscovery(ca);
  }
}

export function startWalletTracker(onDiscovery: (ca: string) => void) {
  if (!cfg().wallets.enabled || !env.HELIUS_API_KEY || !pool) return;
  const tick = async () => {
    await pollOnce(onDiscovery);
    setTimeout(tick, 30_000);
  };
  setTimeout(tick, 120_000);
}

async function pollOnce(onDiscovery: (ca: string) => void) {
  if (!pool) return;
  // prune hit cache (bounded memory)
  const hitCutoff = Date.now() - 24 * 3600_000;
  for (const [ca, at] of recentHits) if (at < hitCutoff) recentHits.delete(ca);
  if (webhookLive()) { activeCount = 0; return; }   // webhook has it — stand down
  try {
    const active = await pool.query(
      `SELECT wallet FROM smart_wallets WHERE active ORDER BY winners_hit DESC, last_validated DESC LIMIT 40`);
    activeCount = active.rows.length;
    for (const { wallet } of active.rows) {
      const txs = await heliusTxs(wallet, 10);
      for (const tx of txs) {
        const age = Date.now() - (tx.timestamp ? tx.timestamp * 1000 : Date.now());
        if (age > 10 * 60_000) continue;
        if (tx.type && tx.type !== 'SWAP') continue;   // anti-dust: only real swaps, not transfers
        for (const tt of tx.tokenTransfers || []) {
          if (tt.toUserAccount !== wallet || !tt.mint) continue;
          recordSmartBuy(wallet, tt.mint, onDiscovery);
        }
      }
    }
  } catch (e) { console.error('[wallets] tracker', (e as Error).message); }
}

export async function smartMoneyHits(ca: string): Promise<number> {
  if (!pool) return 0;
  const hours = cfg().wallets.hit_recency_hours;
  const r = await pool.query(
    `SELECT COUNT(DISTINCT wallet)::int c FROM wallet_hits
     WHERE ca = $1 AND at > now() - ($2 || ' hours')::interval`, [ca, String(hours)]).catch(() => null);
  return r?.rows[0]?.c || 0;
}
