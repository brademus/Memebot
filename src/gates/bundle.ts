import { cfg, env } from '../config';
import { TokenRecord } from '../types';
import { heliusTxs, heliusTxsToCreation } from '../helius';

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
  stats: { insiderPct: number; slot0Buyers: number; fundedSnipers: number; clusterPct?: number } | null;
}

const NEUTRAL: BundleCheck = { pass: true, reason: null, stats: null };

// known Solana CEX / bridge hot wallets — funding from these is NOT a cluster link
// (thousands of unrelated users are funded from the same Binance wallet). Excluding
// them is the crux of MELT's shared-funder heuristic. Extend as needed.
const CEX_FUNDERS = new Set<string>([
  '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9',  // Binance
  '2ojv9BAiHUrvsm9gxDe7fJSzbNZSJcxZvf8dqmWGHG8S',  // Binance 2
  'AC5RDfQFmDS1deWZos921JfqscXdByf8BKHs5ACWjtW2',  // Bybit
  '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',  // (common hot wallet)
  'H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS',  // Coinbase
  'GJRs4FwHtemZ5ZE9x3FNvJ8TMwitKTh21yxdRPqn7npE',  // Coinbase 2
  '2AQdpHJ2JpcEgPiATUXjQxA8QmafFegfQwSLWSprPicm',  // Kraken
  'FWznbcNXWQuHTawe9RxvQ2LdCENssh12dsznf4RiouN5',  // Kraken 2
]);

export async function checkBundle(t: TokenRecord): Promise<BundleCheck> {
  const c = cfg().bundle;
  if (!c.enabled || !env.HELIUS_API_KEY) return NEUTRAL;

  try {
    // 1. earliest txs on the mint (fresh tokens: 100 covers back to creation)
    // MUST reach creation-era txs: insiders/snipers act in the first slots. A
    // single newest-100 page on a busy token never sees creation — the check was
    // verifying the WRONG transactions and could mark bundled tokens falsely
    // clean (corrupting the one proven edge, insider-verified-clean 2.69x).
    const mintTxs = await heliusTxsToCreation(t.ca, 5, 'bg');
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
      const depTxs = await heliusTxs(deployer, 100, undefined, 'bg');
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

    // ===== CLUSTER MERGE (MELT shared-funding heuristic) =====
    // Research (MELT, 41,470 tokens): the SINGLE strongest same-entity signal is a
    // SHARED FUNDING ADDRESS excluding CEX funders — 22.57% of holders / 28.22% of
    // supply, vs 9.16% for deployer co-funding alone. Bundlers now spread supply
    // across 16-25 randomized wallets to look organic; those wallets are almost
    // always funded from ONE upstream address. We trace each slot0 buyer's funder
    // (one hop) and merge buyers sharing a non-CEX funder into a cluster. The merged
    // cluster's supply share is the real concentration — this is what upgrades our
    // proven "clean" edge from binary to graded. Bounded fan-out for Helius budget.
    let clusterPct = insiderPct;
    if (c.cluster_merge_enabled && slot0Buyers > 1 && slot0Buyers <= c.cluster_max_buyers) {
      const funderOf = new Map<string, string>();
      const buyerList = [...buyers.keys()];
      for (const b of buyerList) {
        const bt = await heliusTxs(b, 20, undefined, 'bg');
        // earliest inbound SOL to this buyer = its funder
        let funder: string | null = null, earliest = Infinity;
        for (const tx of bt) {
          for (const nt of tx.nativeTransfers || []) {
            if (nt.toUserAccount === b && nt.fromUserAccount && (tx.timestamp || 0) < earliest
                && !CEX_FUNDERS.has(nt.fromUserAccount)) { funder = nt.fromUserAccount; earliest = tx.timestamp || 0; }
          }
        }
        if (funder) funderOf.set(b, funder);
      }
      // group buyers by shared funder; the largest shared-funder group's supply share
      const byFunder = new Map<string, number>();
      for (const [b, amt] of buyers) {
        const f = funderOf.get(b);
        if (f) byFunder.set(f, (byFunder.get(f) || 0) + amt);
      }
      const maxClusterTokens = byFunder.size ? Math.max(...byFunder.values()) : 0;
      const sharedFunderPct = Math.min(100, (maxClusterTokens / c.total_supply) * 100);
      clusterPct = Math.max(insiderPct, sharedFunderPct);
    }

    t.bundle = { insiderPct: +insiderPct.toFixed(1), slot0Buyers, fundedSnipers, clusterPct: +clusterPct.toFixed(1) } as any;

    if (fundedSnipers >= c.max_funded_snipers)
      return { pass: false, reason: `bundle_funded_snipers_${fundedSnipers}`, stats: t.bundle };
    // gate on the MERGED cluster concentration, not just direct deployer funding
    if (clusterPct > c.max_insider_supply_pct)
      return { pass: false, reason: `bundle_cluster_${clusterPct.toFixed(0)}pct`, stats: t.bundle };
    return { pass: true, reason: null, stats: t.bundle };
  } catch { return NEUTRAL; }
}
