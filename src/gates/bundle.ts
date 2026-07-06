import { cfg, env } from '../config';
import { TokenRecord } from '../types';

// Bundle / insider detection.
// Research basis: >50% of pump.fun launches are sniped in the creation block, and
// deployer-funded same-block snipers are the dominant coordinated-extraction pattern.
// Heuristic (per ChainCatcher/Bitget one-hop funding methodology):
//   1. Pull the token's earliest parsed txs -> buyers in creation slot (+1)
//   2. Pull deployer's tx history -> wallets with direct SOL transfers to/from deployer
//   3. funded snipers = slot0 buyers ∩ deployer-linked wallets
//   4. insider-held % = supply bought by (slot0 ∪ funded) at launch
// Degrades gracefully: no HELIUS_API_KEY = neutral pass.

export interface BundleCheck {
  pass: boolean;
  reason: string | null;
  stats: { insiderPct: number; slot0Buyers: number; fundedSnipers: number } | null;
}

const NEUTRAL: BundleCheck = { pass: true, reason: null, stats: null };

export async function checkBundle(t: TokenRecord): Promise<BundleCheck> {
  const c = cfg().bundle;
  if (!c.enabled || !env.HELIUS_API_KEY) return NEUTRAL;

  try {
    // 1. earliest txs on the mint (fresh tokens: 100 covers back to creation)
    const mintTxs = await heliusTxs(t.ca);
    if (!mintTxs.length) return NEUTRAL;

    const minSlot = Math.min(...mintTxs.map((x: any) => x.slot));
    const deployer = t.creator || mintTxs.find((x: any) => x.slot === minSlot)?.feePayer || null;

    // buyers in creation slot and slot+1, with raw token amounts received
    const buyers = new Map<string, number>();
    for (const tx of mintTxs) {
      if (tx.slot > minSlot + 1) continue;
      for (const tt of tx.tokenTransfers || []) {
        if (tt.mint !== t.ca || !tt.toUserAccount) continue;
        if (tt.toUserAccount === deployer) continue;              // dev buy handled separately
        buyers.set(tt.toUserAccount, (buyers.get(tt.toUserAccount) || 0) + (tt.tokenAmount || 0));
      }
    }
    const slot0Buyers = buyers.size;
    if (!slot0Buyers) { t.bundle = { insiderPct: 0, slot0Buyers: 0, fundedSnipers: 0 }; return { ...NEUTRAL, stats: t.bundle }; }

    // 2. deployer's SOL-transfer counterparties (one hop)
    let linked = new Set<string>();
    if (deployer) {
      const depTxs = await heliusTxs(deployer);
      for (const tx of depTxs) {
        for (const nt of tx.nativeTransfers || []) {
          if (nt.fromUserAccount === deployer && nt.toUserAccount) linked.add(nt.toUserAccount);
          if (nt.toUserAccount === deployer && nt.fromUserAccount) linked.add(nt.fromUserAccount);
        }
      }
    }

    // 3 + 4. intersection and supply share
    let fundedSnipers = 0;
    let insiderTokens = 0;
    for (const [wallet, amt] of buyers) {
      const funded = linked.has(wallet);
      if (funded) fundedSnipers++;
      if (funded || c.count_all_slot0_as_insider) insiderTokens += amt;
    }
    if (!c.count_all_slot0_as_insider && fundedSnipers === 0) {
      // still count raw slot0 share as soft insider metric
      insiderTokens = [...buyers.values()].reduce((s, x) => s + x, 0);
    }
    const insiderPct = Math.min(100, (insiderTokens / c.total_supply) * 100);

    t.bundle = { insiderPct: +insiderPct.toFixed(1), slot0Buyers, fundedSnipers };

    if (fundedSnipers >= c.max_funded_snipers)
      return { pass: false, reason: `bundle_funded_snipers_${fundedSnipers}`, stats: t.bundle };
    if (insiderPct > c.max_insider_supply_pct)
      return { pass: false, reason: `bundle_insider_${insiderPct.toFixed(0)}pct`, stats: t.bundle };
    return { pass: true, reason: null, stats: t.bundle };
  } catch { return NEUTRAL; }
}

async function heliusTxs(address: string): Promise<any[]> {
  const res = await fetch(
    `https://api.helius.xyz/v0/addresses/${address}/transactions?api-key=${env.HELIUS_API_KEY}&limit=100`);
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}
