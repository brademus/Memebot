import { cfg, env } from '../config';
import { TokenRecord } from '../types';
import { heliusTxs, heliusTxsToCreation } from '../helius';
import { analyzeEntityGraph } from '../model/entity-graph';

export interface BundleCheck {
  pass: boolean;
  reason: string | null;
  stats: TokenRecord['bundle'];
}
const NEUTRAL: BundleCheck = { pass: true, reason: null, stats: null };

export async function checkBundle(token: TokenRecord): Promise<BundleCheck> {
  const config = cfg().bundle;
  if (!config.enabled || !env.HELIUS_API_KEY) return NEUTRAL;
  try {
    const mintTransactions = await heliusTxsToCreation(token.ca, 5, 'bg');
    if (!mintTransactions.length) return NEUTRAL;
    const minimumSlot = Math.min(...mintTransactions.map((tx: any) => Number(tx.slot) || Number.MAX_SAFE_INTEGER));
    const deployer = token.creator || mintTransactions.find((tx: any) => Number(tx.slot) === minimumSlot)?.feePayer || null;

    const buyers = new Map<string, number>();
    for (const tx of mintTransactions) {
      if ((Number(tx.slot) || 0) > minimumSlot + 1) continue;
      for (const transfer of tx.tokenTransfers || []) {
        if (transfer.mint !== token.ca || !transfer.toUserAccount || transfer.toUserAccount === deployer) continue;
        buyers.set(transfer.toUserAccount, (buyers.get(transfer.toUserAccount) || 0) + Math.max(0, Number(transfer.tokenAmount) || 0));
      }
    }
    const slot0Buyers = buyers.size;
    if (!slot0Buyers) {
      token.bundle = { insiderPct: 0, slot0Buyers: 0, fundedSnipers: 0 };
      return { pass: true, reason: null, stats: token.bundle };
    }

    const linked = new Set<string>();
    if (deployer) {
      const deployerTransactions = await heliusTxs(deployer, 100, undefined, 'bg');
      for (const tx of deployerTransactions) {
        for (const transfer of tx.nativeTransfers || []) {
          if (transfer.fromUserAccount === deployer && transfer.toUserAccount) linked.add(transfer.toUserAccount);
          if (transfer.toUserAccount === deployer && transfer.fromUserAccount) linked.add(transfer.fromUserAccount);
        }
      }
    }

    let fundedSnipers = 0;
    let insiderTokens = 0;
    for (const [wallet, tokenAmount] of buyers) {
      const funded = linked.has(wallet);
      if (funded) fundedSnipers++;
      if (funded || config.count_all_slot0_as_insider) insiderTokens += tokenAmount;
    }
    if (!config.count_all_slot0_as_insider && fundedSnipers === 0)
      insiderTokens = [...buyers.values()].reduce((sum, value) => sum + value, 0);
    const insiderPct = Math.min(100, insiderTokens / config.total_supply * 100);

    const graph = await analyzeEntityGraph(token, true).catch(() => null);
    const graphSupplyPct = graph ? graph.largestEntitySupplyPct * 100 : 0;
    const clusterPct = Math.max(insiderPct, graphSupplyPct);
    token.bundle = {
      insiderPct: round1(insiderPct),
      slot0Buyers,
      fundedSnipers,
      clusterPct: round1(clusterPct),
      ...(graph || {}),
    };

    if (fundedSnipers >= config.max_funded_snipers)
      return { pass: false, reason: `bundle_funded_snipers_${fundedSnipers}`, stats: token.bundle };
    if (clusterPct > config.max_insider_supply_pct)
      return { pass: false, reason: `bundle_cluster_${clusterPct.toFixed(0)}pct`, stats: token.bundle };
    return { pass: true, reason: null, stats: token.bundle };
  } catch (error) {
    console.error('[bundle]', (error as Error).message);
    return NEUTRAL;
  }
}

const round1 = (value: number) => Math.round(value * 10) / 10;
