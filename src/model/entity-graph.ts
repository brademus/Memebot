import { cfg } from '../config';
import { pool } from '../db';
import { heliusTxs, heliusTxsToCreation } from '../helius';
import { EntityGraphFeatures, TokenRecord } from '../types';
import { MODEL_VERSION } from './version';
import { clamp01, mean, round, standardDeviation } from './math';

const CEX_FUNDERS = new Set([
  '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9',
  '2ojv9BAiHUrvsm9gxDe7fJSzbNZSJcxZvf8dqmWGHG8S',
  'AC5RDfQFmDS1deWZos921JfqscXdByf8BKHs5ACWjtW2',
  '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
  'H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS',
  'GJRs4FwHtemZ5ZE9x3FNvJ8TMwitKTh21yxdRPqn7npE',
  '2AQdpHJ2JpcEgPiATUXjQxA8QmafFegfQwSLWSprPicm',
  'FWznbcNXWQuHTawe9RxvQ2LdCENssh12dsznf4RiouN5',
]);

interface BuyerNode {
  wallet: string;
  tokenAmount: number;
  root: string;
  immediateFunder: string | null;
  fundedAt: number | null;
  firstActivityAt: number | null;
  fundingAmountSol: number | null;
  fundingSource: 'cex' | 'wallet' | 'self' | 'unknown';
  confidence: number;
}

export interface EntityGraphInput {
  buyers: Array<{ wallet: string; tokenAmount: number }>;
  nodes: BuyerNode[];
  deployer: string | null;
  totalSupply: number;
  checkedAt?: number;
}

export function aggregateEntityGraph(input: EntityGraphInput): EntityGraphFeatures {
  const checkedAt = input.checkedAt || Date.now();
  const buyers = input.buyers.filter(buyer => buyer.wallet && buyer.tokenAmount >= 0);
  const nodeByWallet = new Map(input.nodes.map(node => [node.wallet, node]));
  const entityBuyerCounts = new Map<string, number>();
  const entitySupply = new Map<string, number>();
  let fresh = 0;
  let deployerLinked = 0;
  const fundingTimes: number[] = [];
  let resolved = 0;

  for (const buyer of buyers) {
    const node = nodeByWallet.get(buyer.wallet);
    const root = node?.root || buyer.wallet;
    entityBuyerCounts.set(root, (entityBuyerCounts.get(root) || 0) + 1);
    entitySupply.set(root, (entitySupply.get(root) || 0) + buyer.tokenAmount);
    if (node) {
      resolved++;
      if (node.firstActivityAt && checkedAt - node.firstActivityAt < 24 * 3600_000) fresh++;
      if (input.deployer && (node.root === input.deployer || node.immediateFunder === input.deployer)) deployerLinked++;
      if (node.fundedAt) fundingTimes.push(node.fundedAt);
    }
  }

  const count = Math.max(1, buyers.length);
  const independentEntities = entityBuyerCounts.size;
  const largestEntityBuyers = entityBuyerCounts.size ? Math.max(...entityBuyerCounts.values()) : 0;
  const largestEntityTokens = entitySupply.size ? Math.max(...entitySupply.values()) : 0;
  const commonFunderBuyerPct = independentEntities < buyers.length ? largestEntityBuyers / count : 0;
  const fundingSpreadMinutes = fundingTimes.length > 1 ? standardDeviation(fundingTimes) / 60_000 : 0;
  const fundingTimeConcentration = fundingTimes.length > 1 ? clamp01(1 - fundingSpreadMinutes / 30) : 0;
  const independenceRatio = independentEntities / count;
  const freshWalletPct = fresh / count;
  const deployerLinkedPct = deployerLinked / count;
  const largestEntityBuyerPct = largestEntityBuyers / count;
  const largestEntitySupplyPct = input.totalSupply > 0 ? largestEntityTokens / input.totalSupply : 0;
  const complete = buyers.length >= 3 && resolved / count >= 0.65;
  const graphRisk = clamp01(
    0.29 * largestEntityBuyerPct
    + 0.24 * clamp01(largestEntitySupplyPct / 0.25)
    + 0.18 * commonFunderBuyerPct
    + 0.13 * deployerLinkedPct
    + 0.09 * freshWalletPct
    + 0.07 * fundingTimeConcentration
    + (complete ? 0 : 0.12),
  );

  return {
    checkedAt,
    buyersAnalyzed: buyers.length,
    independentEntities,
    independenceRatio: round(independenceRatio),
    largestEntityBuyerPct: round(largestEntityBuyerPct),
    largestEntitySupplyPct: round(largestEntitySupplyPct),
    commonFunderBuyerPct: round(commonFunderBuyerPct),
    freshWalletPct: round(freshWalletPct),
    deployerLinkedPct: round(deployerLinkedPct),
    fundingTimeConcentration: round(fundingTimeConcentration),
    graphRisk: round(graphRisk),
    roots: entityBuyerCounts.size,
    complete,
  };
}

export async function analyzeEntityGraph(token: TokenRecord, force = false): Promise<EntityGraphFeatures | null> {
  if (!pool || !token.ca || !token.creator) return token.entityGraph;
  if (!force && token.entityGraph && Date.now() - token.entityGraph.checkedAt < 20 * 60_000) return token.entityGraph;

  const mintTransactions = await heliusTxsToCreation(token.ca, 5, 'bg');
  if (!mintTransactions.length) return token.entityGraph;
  const minimumSlot = Math.min(...mintTransactions.map((tx: any) => Number(tx.slot) || Number.MAX_SAFE_INTEGER));
  const amounts = new Map<string, number>();
  for (const tx of mintTransactions) {
    if ((Number(tx.slot) || 0) > minimumSlot + 3) continue;
    for (const transfer of tx.tokenTransfers || []) {
      if (transfer.mint !== token.ca || !transfer.toUserAccount || transfer.toUserAccount === token.creator) continue;
      amounts.set(transfer.toUserAccount, (amounts.get(transfer.toUserAccount) || 0) + Math.max(0, Number(transfer.tokenAmount) || 0));
    }
  }
  const buyers = [...amounts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, Math.min(30, cfg().bundle.cluster_max_buyers))
    .map(([wallet, tokenAmount]) => ({ wallet, tokenAmount }));
  if (!buyers.length) return token.entityGraph;

  const nodes: BuyerNode[] = [];
  for (let index = 0; index < buyers.length; index += 5) {
    const batch = await Promise.all(buyers.slice(index, index + 5).map(buyer => resolveFundingRoot(buyer.wallet)));
    nodes.push(...batch);
  }
  const features = aggregateEntityGraph({ buyers, nodes, deployer: token.creator, totalSupply: cfg().bundle.total_supply });
  token.entityGraph = features;
  await pool.query(
    `INSERT INTO token_entity_features
       (ca,model_version,checked_at,buyers_analyzed,independent_entities,independence_ratio,
        largest_entity_buyer_pct,largest_entity_supply_pct,common_funder_buyer_pct,fresh_wallet_pct,
        deployer_linked_pct,funding_time_concentration,graph_risk,roots,complete,details)
     VALUES ($1,$2,to_timestamp($3/1000.0),$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     ON CONFLICT (ca) DO UPDATE SET
       model_version=$2,checked_at=to_timestamp($3/1000.0),buyers_analyzed=$4,independent_entities=$5,
       independence_ratio=$6,largest_entity_buyer_pct=$7,largest_entity_supply_pct=$8,
       common_funder_buyer_pct=$9,fresh_wallet_pct=$10,deployer_linked_pct=$11,
       funding_time_concentration=$12,graph_risk=$13,roots=$14,complete=$15,details=$16`,
    [token.ca, MODEL_VERSION, features.checkedAt, features.buyersAnalyzed, features.independentEntities,
     features.independenceRatio, features.largestEntityBuyerPct, features.largestEntitySupplyPct,
     features.commonFunderBuyerPct, features.freshWalletPct, features.deployerLinkedPct,
     features.fundingTimeConcentration, features.graphRisk, features.roots, features.complete,
     JSON.stringify({ nodes: nodes.map(node => ({ ...node, tokenAmount: amounts.get(node.wallet) || 0 })) })],
  ).catch(error => console.error('[entity-graph] persist', error.message));
  return features;
}

async function resolveFundingRoot(wallet: string): Promise<BuyerNode> {
  if (pool) {
    const cached = await pool.query(
      `SELECT root_wallet,immediate_funder,EXTRACT(EPOCH FROM first_seen_at)*1000 AS first_seen_ms,
              EXTRACT(EPOCH FROM first_funded_at)*1000 AS funded_ms,funding_amount_sol,funding_source,confidence
         FROM wallet_funding_roots WHERE wallet=$1 AND checked_at>now()-interval '7 days'`, [wallet],
    ).catch(() => ({ rows: [] as any[] }));
    if (cached.rows.length) {
      const row = cached.rows[0];
      return {
        wallet, tokenAmount: 0, root: row.root_wallet || wallet, immediateFunder: row.immediate_funder || null,
        fundedAt: numberOrNull(row.funded_ms), firstActivityAt: numberOrNull(row.first_seen_ms),
        fundingAmountSol: numberOrNull(row.funding_amount_sol), fundingSource: row.funding_source || 'unknown',
        confidence: Number(row.confidence) || 0,
      };
    }
  }

  const transactions = await heliusTxs(wallet, 100, undefined, 'bg');
  const sorted = [...transactions].sort((left: any, right: any) => (Number(left.timestamp) || 0) - (Number(right.timestamp) || 0));
  const firstActivityAt = sorted.length && sorted[0].timestamp ? Number(sorted[0].timestamp) * 1000 : null;
  let immediateFunder: string | null = null;
  let fundedAt: number | null = null;
  let fundingAmountSol: number | null = null;
  for (const tx of sorted) {
    for (const transfer of tx.nativeTransfers || []) {
      if (transfer.toUserAccount !== wallet || !transfer.fromUserAccount || transfer.fromUserAccount === wallet) continue;
      immediateFunder = transfer.fromUserAccount;
      fundedAt = tx.timestamp ? Number(tx.timestamp) * 1000 : null;
      const amount = Number(transfer.amount) || 0;
      fundingAmountSol = amount > 1_000_000 ? amount / 1_000_000_000 : amount;
      break;
    }
    if (immediateFunder) break;
  }
  const fundingSource: BuyerNode['fundingSource'] = !immediateFunder ? 'self' : CEX_FUNDERS.has(immediateFunder) ? 'cex' : 'wallet';
  const root = fundingSource === 'wallet' && immediateFunder ? immediateFunder : wallet;
  const confidence = immediateFunder ? (fundingSource === 'cex' ? 0.45 : 0.85) : 0.35;
  const node: BuyerNode = { wallet, tokenAmount: 0, root, immediateFunder, fundedAt, firstActivityAt, fundingAmountSol, fundingSource, confidence };
  if (pool) await pool.query(
    `INSERT INTO wallet_funding_roots
       (wallet,root_wallet,immediate_funder,first_seen_at,first_funded_at,funding_amount_sol,funding_source,confidence,checked_at)
     VALUES ($1,$2,$3,CASE WHEN $4::bigint IS NULL THEN NULL ELSE to_timestamp($4/1000.0) END,
             CASE WHEN $5::bigint IS NULL THEN NULL ELSE to_timestamp($5/1000.0) END,$6,$7,$8,now())
     ON CONFLICT (wallet) DO UPDATE SET root_wallet=$2,immediate_funder=$3,
       first_seen_at=CASE WHEN $4::bigint IS NULL THEN wallet_funding_roots.first_seen_at ELSE to_timestamp($4/1000.0) END,
       first_funded_at=CASE WHEN $5::bigint IS NULL THEN wallet_funding_roots.first_funded_at ELSE to_timestamp($5/1000.0) END,
       funding_amount_sol=$6,funding_source=$7,confidence=$8,checked_at=now()`,
    [wallet, root, immediateFunder, firstActivityAt, fundedAt, fundingAmountSol, fundingSource, confidence],
  ).catch(() => {});
  return node;
}

function numberOrNull(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}
