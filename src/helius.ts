import { env } from './config';

// Shared Helius helpers. Enhanced-transactions API returns parsed token/native transfers.
export async function heliusTxs(address: string, limit = 100): Promise<any[]> {
  if (!env.HELIUS_API_KEY) return [];
  try {
    const res = await fetch(
      `https://api.helius.xyz/v0/addresses/${address}/transactions?api-key=${env.HELIUS_API_KEY}&limit=${limit}`);
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch { return []; }
}

// Earliest buyers of a mint: wallets that received the token in its first N slots.
export async function earlyBuyers(mint: string, slotWindow = 3): Promise<string[]> {
  const txs = await heliusTxs(mint, 100);
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
