import { env } from './config';

const RPS = 40;
let tokens = RPS;
let lastRefill = Date.now();
const fg: (() => void)[] = [];
const bg: (() => void)[] = [];
const limiterTimer = setInterval(() => {
  const now = Date.now();
  tokens = Math.min(RPS, tokens + (RPS * (now - lastRefill)) / 1000);
  lastRefill = now;
  while (tokens >= 1 && (fg.length || bg.length)) {
    tokens -= 1;
    (fg.length ? fg.shift()! : bg.shift()!)();
  }
}, 25);
limiterTimer.unref();

function rateLimit(priority: 'fg' | 'bg' = 'fg'): Promise<void> {
  totalCalls++;
  const queue = priority === 'bg' ? bg : fg;
  if (tokens >= 1 && (priority === 'fg' || fg.length === 0)) {
    tokens -= 1;
    return Promise.resolve();
  }
  throttledCalls++;
  return new Promise(resolve => queue.push(resolve));
}

let totalCalls = 0, throttledCalls = 0, got429 = 0;
export const heliusHealth = () => ({
  rps: RPS, queuedFg: fg.length, queuedBg: bg.length, queued: fg.length + bg.length,
  totalCalls, throttledCalls, got429,
  throttlePct: totalCalls ? Math.round(throttledCalls / totalCalls * 100) : 0,
});
export const note429 = () => { got429++; };

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
        await new Promise(resolve => setTimeout(resolve, 400 * (attempt + 1) + Math.random() * 200));
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

export async function heliusTxsToCreation(address: string, maxPages = 5, priority: 'fg' | 'bg' = 'bg'): Promise<any[]> {
  let all: any[] = [];
  let before: string | undefined;
  for (let index = 0; index < maxPages; index++) {
    const page = await heliusTxs(address, 100, before, priority);
    if (!page.length) break;
    all = all.concat(page);
    if (page.length < 100) break;
    before = page[page.length - 1].signature;
  }
  return all;
}

export async function earlyBuyers(mint: string, slotWindow = 3): Promise<string[]> {
  const txs = await heliusTxsToCreation(mint);
  if (!txs.length) return [];
  const minSlot = Math.min(...txs.map((tx: any) => tx.slot));
  const buyers = new Set<string>();
  for (const tx of txs) {
    if (tx.slot > minSlot + slotWindow) continue;
    for (const transfer of tx.tokenTransfers || [])
      if (transfer.mint === mint && transfer.toUserAccount) buyers.add(transfer.toUserAccount);
  }
  return [...buyers];
}
