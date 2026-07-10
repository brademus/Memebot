import { env } from './config';

// Shared Helius helpers. Enhanced-transactions API returns parsed token/native transfers.
export async function heliusTxs(address: string, limit = 100, before?: string): Promise<any[]> {
  if (!env.HELIUS_API_KEY) return [];
  const url = `https://api.helius.xyz/v0/addresses/${address}/transactions?api-key=${env.HELIUS_API_KEY}&limit=${limit}`
    + (before ? `&before=${before}` : '');
  // up to 3 attempts: a hung request must not stall the caller (6s timeout), and a
  // 429 must not be silently swallowed as "no data" — that was quietly capping
  // insider verification, the strongest signal we have. Back off and retry.
  for (let attempt = 0; attempt < 3; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (res.status === 429) {
        const wait = 400 * (attempt + 1) + Math.random() * 200;
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      if (!res.ok) return [];
      const data = await res.json();
      return Array.isArray(data) ? data : [];
    } catch {
      if (attempt === 2) return [];    // timeout/network — give up after last try
    } finally { clearTimeout(timer); }
  }
  return [];
}

// Walk a token's history back toward creation (newest-first pages). Busy winners
// have >100 txs, so a single page never reaches the early buyers.
export async function heliusTxsToCreation(address: string, maxPages = 5): Promise<any[]> {
  let all: any[] = [];
  let before: string | undefined;
  for (let i = 0; i < maxPages; i++) {
    const page = await heliusTxs(address, 100, before);
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
