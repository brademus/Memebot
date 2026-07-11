import { env } from './config';

// PRIORITY RATE LIMITER — Developer tier is 50 RPS; we cap at 40 with margin.
// But a single FIFO queue caused a real bug: heavy BACKGROUND work (wallet history
// walks — hundreds of calls when discovery + the winner-miner fire) shared one
// queue with LATENCY-CRITICAL FOREGROUND work (live price enrichment, new-token
// gating, wallet-buy processing). A ~465-call analysis burst = ~12s of queue, and
// every live update stalled behind it — that's the "scanner is slow / data is slow"
// symptom. Fix: two lanes. Foreground always drains first; background only gets a
// token when no foreground work is waiting. Same 40 RPS ceiling, but live data
// never waits behind a background analysis burst.
const RPS = 40;
let tokens = RPS;
let lastRefill = Date.now();
const fg: (() => void)[] = [];   // foreground: live scanner, webhook, enrichment
const bg: (() => void)[] = [];   // background: wallet history walks
setInterval(() => {
  const now = Date.now();
  tokens = Math.min(RPS, tokens + (RPS * (now - lastRefill)) / 1000);
  lastRefill = now;
  while (tokens >= 1 && (fg.length || bg.length)) {
    tokens -= 1;
    (fg.length ? fg.shift()! : bg.shift()!)();   // foreground drains completely first
  }
}, 25);
function rateLimit(priority: 'fg' | 'bg' = 'fg'): Promise<void> {
  totalCalls++;
  const q = priority === 'bg' ? bg : fg;
  // fast path only if the OTHER lane isn't already waiting ahead (preserve priority)
  if (tokens >= 1 && (priority === 'fg' ? true : fg.length === 0)) { tokens -= 1; return Promise.resolve(); }
  throttledCalls++;
  return new Promise(resolve => q.push(resolve));
}
let totalCalls = 0, throttledCalls = 0, got429 = 0;
export const heliusHealth = () => ({
  rps: RPS, queuedFg: fg.length, queuedBg: bg.length, queued: fg.length + bg.length,
  totalCalls, throttledCalls, got429,
  throttlePct: totalCalls ? Math.round((throttledCalls / totalCalls) * 100) : 0,
});
export const note429 = () => { got429++; };

// Shared Helius helpers. Enhanced-transactions API returns parsed token/native transfers.
// `priority` lets background callers (wallet analysis) yield to live foreground work.
export async function heliusTxs(address: string, limit = 100, before?: string, priority: 'fg' | 'bg' = 'fg'): Promise<any[]> {
  if (!env.HELIUS_API_KEY) return [];
  const url = `https://api.helius.xyz/v0/addresses/${address}/transactions?api-key=${env.HELIUS_API_KEY}&limit=${limit}`
    + (before ? `&before=${before}` : '');
  for (let attempt = 0; attempt < 3; attempt++) {
    await rateLimit(priority);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (res.status === 429) {
        note429();
        const wait = 400 * (attempt + 1) + Math.random() * 200;
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      if (!res.ok) return [];
      const data = await res.json();
      return Array.isArray(data) ? data : [];
    } catch {
      if (attempt === 2) return [];
    } finally { clearTimeout(timer); }
  }
  return [];
}

// Walk a token's history back toward creation (newest-first pages). Busy winners
// have >100 txs, so a single page never reaches the early buyers.
export async function heliusTxsToCreation(address: string, maxPages = 5, priority: 'fg' | 'bg' = 'bg'): Promise<any[]> {
  let all: any[] = [];
  let before: string | undefined;
  for (let i = 0; i < maxPages; i++) {
    const page = await heliusTxs(address, 100, before, priority);
    if (!page.length) break;
    all = all.concat(page);
    if (page.length < 100) break;          // reached the beginning
    before = page[page.length - 1].signature;
  }
  return all;
}

// Earliest buyers of a mint: wallets that received the token in its first N slots.
export async function earlyBuyers(mint: string, slotWindow = 3): Promise<string[]> {
  const txs = await heliusTxsToCreation(mint);
  if (!txs.length) return [];
  const minSlot = Math.min(...txs.map((t: any) => t.slot));
  const buyers = new Set<string>();
  for (const tx of txs) {
    if (tx.slot > minSlot + slotWindow) continue;
    for (const tt of tx.tokenTransfers || []) {
      if (tt.mint === mint && tt.toUserAccount) buyers.add(tt.toUserAccount);
    }
  }
  return [...buyers];
}
