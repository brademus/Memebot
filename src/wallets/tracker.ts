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

// WALLET TIERS — a 31-winner wallet is not a 2-winner wallet. Weights come from
// winners_hit: ELITE wallets (>= elite_min_winners) carry elite_weight in every
// piece of confluence math (scoring, smart lane, conviction), so one elite buy
// can move the pipeline by itself.
const walletWinners = new Map<string, number>();   // wallet -> winners_hit
export function setWalletWeights(rows: { wallet: string; winners_hit: number }[]) {
  for (const r of rows) walletWinners.set(r.wallet, Number(r.winners_hit) || 0);
}
export function walletWeight(wallet: string): number {
  const w = cfg().wallets;
  return (walletWinners.get(wallet) || 0) >= (w.elite_min_winners ?? 10) ? (w.elite_weight ?? 3) : 1;
}
// weighted distinct confluence within a window — THE smart-money number
export function weightedSmartHits(hits: { wallet: string; at: number; w: number }[], windowMs: number, now = Date.now()) {
  const seen = new Map<string, number>();
  for (const h of hits) if (now - h.at < windowMs) seen.set(h.wallet, Math.max(seen.get(h.wallet) || 0, h.w || 1));
  let weight = 0, elite = 0;
  for (const w of seen.values()) { weight += w; if (w > 1) elite++; }
  return { wallets: seen.size, weight, elite };
}

// shared hit recorder — used by BOTH the poller and the webhook
export function recordSmartBuy(wallet: string, ca: string, onDiscovery: (ca: string) => void) {
  recentHits.set(ca, Date.now());
  if (pool) {
    pool.query(`INSERT INTO wallet_hits (ca, wallet) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [ca, wallet]).catch(() => {});
    // stamp activity — this wallet bought something RIGHT NOW. Ranking + copy-trade
    // surfacing use this so idle historical wallets fall off the top.
    pool.query(`UPDATE smart_wallets SET last_active = now() WHERE wallet = $1`, [wallet]).catch(() => {});
  }
  const w = walletWeight(wallet);
  const existing = getToken(ca);
  if (existing) {
    // update-or-append, keeping the array deduped by wallet (latest timestamp
    // wins) and bounded — a wallet re-buying over hours previously appended
    // forever. Confluence math dedupes at read time; this bounds memory.
    const prior = existing.smartHits.find(h => h.wallet === wallet);
    if (prior) { prior.at = Date.now(); prior.w = w; }
    else {
      existing.smartHits.push({ wallet, at: Date.now(), w });
      if (existing.smartHits.length > 100) existing.smartHits.shift();
      if (w > 1) console.log(`[wallets] ◆ ELITE buy: ${wallet.slice(0, 4)}…(${walletWinners.get(wallet)} winners) -> $${existing.symbol}`);
    }
  } else {
    onDiscovery(ca);
    // the surfaced token exists after onDiscovery — credit the hit that surfaced it
    const t = getToken(ca);
    if (t && !t.smartHits.some(h => h.wallet === wallet)) t.smartHits.push({ wallet, at: Date.now(), w });
    if (w > 1) console.log(`[wallets] ◆ ELITE wallet surfaced ${ca}`);
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
      `SELECT wallet, winners_hit FROM smart_wallets WHERE active ORDER BY winners_hit DESC, last_validated DESC LIMIT 40`);
    activeCount = active.rows.length;
    setWalletWeights(active.rows);
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
