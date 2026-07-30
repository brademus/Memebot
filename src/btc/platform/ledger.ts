import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { pool } from '../../db';
import { ExecutionEvent } from './execution';
import {
  PaperCall,
  RiskPlan,
  StrategyCandidate,
  StrategyDefinition,
  StrategyPerformance,
} from './types';

const toDate = (milliseconds: number): Date => new Date(milliseconds);
const number = (value: unknown, fallback = 0): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export async function initializeBtcPlatformSchema(): Promise<void> {
  if (!pool) return;
  const file = path.join(process.cwd(), 'schema-btc.sql');
  if (!fs.existsSync(file)) throw new Error('schema-btc.sql is missing');
  await pool.query(fs.readFileSync(file, 'utf8'));
}

function fingerprint(strategy: StrategyDefinition): string {
  return crypto.createHash('sha256').update(JSON.stringify({
    id: strategy.id,
    version: strategy.version,
    name: strategy.name,
    description: strategy.description,
    mode: strategy.mode,
    leverageCap: strategy.leverageCap,
  })).digest('hex');
}

export async function registerStrategies(strategies: readonly StrategyDefinition[]): Promise<void> {
  if (!pool) return;
  for (const strategy of strategies) {
    await pool.query(`INSERT INTO btc_strategy_definitions(strategy_id,strategy_name,description,mode)
      VALUES($1,$2,$3,$4)
      ON CONFLICT(strategy_id) DO UPDATE SET strategy_name=EXCLUDED.strategy_name,
        description=EXCLUDED.description,mode=EXCLUDED.mode,updated_at=now()`,
    [strategy.id, strategy.name, strategy.description, strategy.mode]);
    await pool.query(`INSERT INTO btc_strategy_versions
      (strategy_id,strategy_version,leverage_cap,configuration,code_fingerprint)
      VALUES($1,$2,$3,$4::jsonb,$5)
      ON CONFLICT(strategy_id,strategy_version) DO NOTHING`,
    [strategy.id, strategy.version, strategy.leverageCap, JSON.stringify({ mode: strategy.mode }), fingerprint(strategy)]);
  }
}

export async function persistCandidate(candidate: StrategyCandidate): Promise<boolean> {
  if (!pool) return true;
  const result = await pool.query(`INSERT INTO btc_signal_candidates
    (candidate_id,strategy_id,strategy_version,direction,setup_type,mode,created_at,expires_at,
     entry_method,preferred_entry,entry_zone_low,entry_zone_high,do_not_chase_price,structural_stop,
     initial_target,extended_target,maximum_realistic_target,minimum_rr,strategy_leverage_cap,
     scores,rationale,features)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb,$21::jsonb,$22::jsonb)
    ON CONFLICT(candidate_id) DO NOTHING`, [
    candidate.id, candidate.strategyId, candidate.strategyVersion, candidate.direction,
    candidate.setupType, candidate.mode, toDate(candidate.createdAt), toDate(candidate.expiresAt),
    candidate.entryMethod, candidate.preferredEntry, candidate.entryZoneLow, candidate.entryZoneHigh,
    candidate.doNotChasePrice, candidate.structuralStop, candidate.initialTarget, candidate.extendedTarget,
    candidate.maximumRealisticTarget, candidate.minimumRR, candidate.strategyLeverageCap,
    JSON.stringify(candidate.scores), JSON.stringify(candidate.rationale), JSON.stringify(candidate.features),
  ]);
  return (result.rowCount || 0) > 0;
}

export async function persistRiskDecision(
  candidate: StrategyCandidate,
  book: 'research' | 'actionable',
  plan: RiskPlan,
  extraReasons: string[] = [],
): Promise<void> {
  if (!pool) return;
  const reasons = [...new Set([...plan.rejectionReasons, ...extraReasons])];
  await pool.query(`INSERT INTO btc_risk_decisions
    (candidate_id,book,approved,reasons,margin_usd,leverage,notional_usd,entry_price,stop_price,target_price,
     extended_target_price,liquidation_price,liquidation_buffer_pct,estimated_risk_usd,estimated_reward_usd,
     estimated_net_rr,estimated_target_roi_pct,estimated_costs)
    VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb)`, [
    candidate.id, book, plan.approved && extraReasons.length === 0, JSON.stringify(reasons),
    plan.marginUsd, plan.leverage, plan.notionalUsd, plan.entryPrice || null, plan.stopPrice || null,
    plan.targetPrice || null, plan.extendedTargetPrice, plan.liquidationPrice || null,
    plan.liquidationBufferPct, plan.estimatedRiskUsd, plan.estimatedRewardUsd, plan.estimatedNetRR,
    plan.estimatedTargetRoiPct, JSON.stringify({
      ...plan.costs,
      actionableTier: plan.actionableTier ?? null,
      expectancyEvidence: plan.expectancyEvidence ?? null,
    }),
  ]);
  await pool.query(`UPDATE btc_signal_candidates SET decision_status=$2,decision_reason=$3,decided_at=now()
    WHERE candidate_id=$1`, [candidate.id, plan.approved && extraReasons.length === 0 ? 'approved' : 'rejected', reasons.join('; ') || null]);
}

export async function markCandidateDecision(candidateId: string, status: 'merged' | 'expired' | 'missed', reason: string): Promise<void> {
  if (!pool) return;
  await pool.query(`UPDATE btc_signal_candidates SET decision_status=$2,decision_reason=$3,decided_at=now()
    WHERE candidate_id=$1`, [candidateId, status, reason]);
}

function callValues(call: PaperCall): unknown[] {
  return [
    call.id, call.book, call.strategyId, call.strategyVersion, call.strategyName,
    JSON.stringify(call.supportingStrategies), call.direction, call.status, call.marginUsd, call.leverage,
    call.notionalUsd, call.entryPrice, call.currentPrice, call.stopPrice, call.targetPrice,
    call.extendedTargetPrice, call.liquidationPrice, call.confidence, toDate(call.openedAt),
    call.closedAt === null ? null : toDate(call.closedAt), call.exitPrice, call.exitReason,
    call.realizedPnlUsd, call.unrealizedPnlUsd, call.netPnlUsd, call.roiPct, call.currentR,
    call.resultR, call.maxFavorableR, call.maxAdverseR, call.remainingFraction, call.runnerActivated,
    call.trailingStopPrice, call.feesUsd, call.fundingUsd, toDate(call.entryAlertAt),
    toDate(call.simulatedFillAt), JSON.stringify(call.rationale), JSON.stringify(call.features),
  ];
}

export async function insertCall(call: PaperCall): Promise<void> {
  if (!pool) return;
  await pool.query(`INSERT INTO btc_paper_calls
    (call_id,book,strategy_id,strategy_version,strategy_name,supporting_strategies,direction,status,
     margin_usd,leverage,notional_usd,entry_price,current_price,stop_price,target_price,extended_target_price,
     liquidation_price,confidence,opened_at,closed_at,exit_price,exit_reason,realized_pnl_usd,
     unrealized_pnl_usd,net_pnl_usd,roi_pct,current_r,result_r,max_favorable_r,max_adverse_r,
     remaining_fraction,runner_activated,trailing_stop_price,fees_usd,funding_usd,entry_alert_at,
     simulated_fill_at,rationale,features)
    VALUES(${Array.from({ length: 39 }, (_, index) => `$${index + 1}`).join(',')})`, callValues(call));
}

export async function updateCall(call: PaperCall): Promise<void> {
  if (!pool) return;
  await pool.query(`UPDATE btc_paper_calls SET status=$2,current_price=$3,stop_price=$4,target_price=$5,
    extended_target_price=$6,closed_at=$7,exit_price=$8,exit_reason=$9,realized_pnl_usd=$10,
    unrealized_pnl_usd=$11,net_pnl_usd=$12,roi_pct=$13,current_r=$14,result_r=$15,
    max_favorable_r=$16,max_adverse_r=$17,remaining_fraction=$18,runner_activated=$19,
    trailing_stop_price=$20,fees_usd=$21,funding_usd=$22,updated_at=now() WHERE call_id=$1`, [
    call.id, call.status, call.currentPrice, call.stopPrice, call.targetPrice, call.extendedTargetPrice,
    call.closedAt === null ? null : toDate(call.closedAt), call.exitPrice, call.exitReason,
    call.realizedPnlUsd, call.unrealizedPnlUsd, call.netPnlUsd, call.roiPct, call.currentR,
    call.resultR, call.maxFavorableR, call.maxAdverseR, call.remainingFraction, call.runnerActivated,
    call.trailingStopPrice, call.feesUsd, call.fundingUsd,
  ]);
}

export async function appendCallEvent(event: ExecutionEvent): Promise<void> {
  if (!pool) return;
  await pool.query(`INSERT INTO btc_call_events
    (call_id,event_type,event_at,price,reason,realized_pnl_delta_usd,snapshot)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`, [
    event.call.id, event.type, toDate(event.timestamp), event.price, event.reason,
    event.realizedPnlDeltaUsd, JSON.stringify({
      status: event.call.status,
      netPnlUsd: event.call.netPnlUsd,
      roiPct: event.call.roiPct,
      currentR: event.call.currentR,
      remainingFraction: event.call.remainingFraction,
      trailingStopPrice: event.call.trailingStopPrice,
    }),
  ]);
  if (event.type === 'pnl_snapshot') {
    const liquidationBufferPct = Math.abs(event.call.currentPrice - event.call.liquidationPrice) / event.call.entryPrice * 100;
    await pool.query(`INSERT INTO btc_pnl_snapshots
      (call_id,snapshot_at,mark_price,executable_exit_price,realized_pnl_usd,unrealized_pnl_usd,
       net_pnl_usd,roi_pct,current_r,liquidation_buffer_pct)
      VALUES($1,date_trunc('minute',$2::timestamptz),$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT(call_id,snapshot_at) DO UPDATE SET mark_price=EXCLUDED.mark_price,
       executable_exit_price=EXCLUDED.executable_exit_price,realized_pnl_usd=EXCLUDED.realized_pnl_usd,
       unrealized_pnl_usd=EXCLUDED.unrealized_pnl_usd,net_pnl_usd=EXCLUDED.net_pnl_usd,
       roi_pct=EXCLUDED.roi_pct,current_r=EXCLUDED.current_r,liquidation_buffer_pct=EXCLUDED.liquidation_buffer_pct`, [
      event.call.id, toDate(event.timestamp), event.call.currentPrice, event.price,
      event.call.realizedPnlUsd, event.call.unrealizedPnlUsd, event.call.netPnlUsd,
      event.call.roiPct, event.call.currentR, liquidationBufferPct,
    ]);
  }
}

function rowToCall(row: any): PaperCall {
  return {
    id: String(row.call_id),
    book: row.book,
    strategyId: String(row.strategy_id),
    strategyVersion: String(row.strategy_version),
    strategyName: String(row.strategy_name),
    supportingStrategies: Array.isArray(row.supporting_strategies) ? row.supporting_strategies : [],
    direction: row.direction,
    status: row.status,
    marginUsd: number(row.margin_usd),
    leverage: number(row.leverage),
    notionalUsd: number(row.notional_usd),
    entryPrice: number(row.entry_price),
    currentPrice: number(row.current_price),
    stopPrice: number(row.stop_price),
    targetPrice: number(row.target_price),
    extendedTargetPrice: row.extended_target_price === null ? null : number(row.extended_target_price),
    liquidationPrice: number(row.liquidation_price),
    confidence: number(row.confidence),
    openedAt: Date.parse(row.opened_at),
    closedAt: row.closed_at ? Date.parse(row.closed_at) : null,
    exitPrice: row.exit_price === null ? null : number(row.exit_price),
    exitReason: row.exit_reason || null,
    realizedPnlUsd: number(row.realized_pnl_usd),
    unrealizedPnlUsd: number(row.unrealized_pnl_usd),
    netPnlUsd: number(row.net_pnl_usd),
    roiPct: number(row.roi_pct),
    currentR: number(row.current_r),
    resultR: row.result_r === null ? null : number(row.result_r),
    maxFavorableR: number(row.max_favorable_r),
    maxAdverseR: number(row.max_adverse_r),
    remainingFraction: number(row.remaining_fraction, 1),
    runnerActivated: !!row.runner_activated,
    trailingStopPrice: row.trailing_stop_price === null ? null : number(row.trailing_stop_price),
    feesUsd: number(row.fees_usd),
    fundingUsd: number(row.funding_usd),
    entryAlertAt: Date.parse(row.entry_alert_at),
    simulatedFillAt: Date.parse(row.simulated_fill_at),
    rationale: Array.isArray(row.rationale) ? row.rationale : [],
    features: row.features && typeof row.features === 'object' ? row.features : {},
  };
}

export async function loadActiveCalls(): Promise<PaperCall[]> {
  if (!pool) return [];
  const result = await pool.query(`SELECT * FROM btc_paper_calls
    WHERE status IN ('armed','open','partial') ORDER BY opened_at`);
  return result.rows.map(rowToCall);
}

export async function loadRecentCalls(limit = 250): Promise<PaperCall[]> {
  if (!pool) return [];
  const result = await pool.query(`SELECT * FROM btc_paper_calls ORDER BY opened_at DESC LIMIT $1`, [limit]);
  return result.rows.map(rowToCall);
}

export async function strategyPerformance(strategies: readonly StrategyDefinition[]): Promise<StrategyPerformance[]> {
  if (!pool) return strategies.map(strategy => ({
    strategyId: strategy.id, strategyVersion: strategy.version, strategyName: strategy.name,
    mode: strategy.mode, leverageCap: strategy.leverageCap, activeCalls: 0, totalCalls: 0,
    wins: 0, losses: 0, winRatePct: null, netPnlUsd: 0, averageR: null, profitFactor: null,
  }));
  const result = await pool.query(`SELECT strategy_id,strategy_version,
    COUNT(*)::int total_calls,
    COUNT(*) FILTER (WHERE status IN ('armed','open','partial'))::int active_calls,
    COUNT(*) FILTER (WHERE status='won')::int wins,
    COUNT(*) FILTER (WHERE status IN ('lost','liquidated'))::int losses,
    COALESCE(SUM(net_pnl_usd) FILTER (WHERE status IN ('won','lost','liquidated')),0) net_pnl,
    AVG(result_r) FILTER (WHERE status IN ('won','lost','liquidated') AND result_r IS NOT NULL) average_r,
    COALESCE(SUM(net_pnl_usd) FILTER (
      WHERE status IN ('won','lost','liquidated') AND net_pnl_usd>0
    ),0) gross_profit,
    ABS(COALESCE(SUM(net_pnl_usd) FILTER (
      WHERE status IN ('won','lost','liquidated') AND net_pnl_usd<0
    ),0)) gross_loss
   FROM btc_paper_calls WHERE book='research' GROUP BY strategy_id,strategy_version`);
  const rows = new Map(result.rows.map(row => [`${row.strategy_id}:${row.strategy_version}`, row]));
  return strategies.map(strategy => {
    const row = rows.get(`${strategy.id}:${strategy.version}`) as any;
    const wins = number(row?.wins);
    const losses = number(row?.losses);
    const grossLoss = number(row?.gross_loss);
    return {
      strategyId: strategy.id,
      strategyVersion: strategy.version,
      strategyName: strategy.name,
      mode: strategy.mode,
      leverageCap: strategy.leverageCap,
      activeCalls: number(row?.active_calls),
      totalCalls: number(row?.total_calls),
      wins,
      losses,
      winRatePct: wins + losses ? wins / (wins + losses) * 100 : null,
      netPnlUsd: number(row?.net_pnl),
      averageR: row?.average_r === null || row?.average_r === undefined ? null : number(row.average_r),
      profitFactor: grossLoss > 0 ? number(row?.gross_profit) / grossLoss : null,
    };
  });
}


export interface BtcPnlLedgerSummary {
  actionableResolvedCalls: number;
  researchResolvedCalls: number;
  actionableWins: number;
  actionableLosses: number;
  researchWins: number;
  researchLosses: number;
  actionableRealizedPnlUsd: number;
  researchRealizedPnlUsd: number;
  actionableResolvedMarginUsd: number;
  researchResolvedMarginUsd: number;
}

const EMPTY_PNL_LEDGER_SUMMARY: BtcPnlLedgerSummary = {
  actionableResolvedCalls: 0,
  researchResolvedCalls: 0,
  actionableWins: 0,
  actionableLosses: 0,
  researchWins: 0,
  researchLosses: 0,
  actionableRealizedPnlUsd: 0,
  researchRealizedPnlUsd: 0,
  actionableResolvedMarginUsd: 0,
  researchResolvedMarginUsd: 0,
};

export async function pnlLedgerSummary(): Promise<BtcPnlLedgerSummary> {
  if (!pool) return { ...EMPTY_PNL_LEDGER_SUMMARY };
  const result = await pool.query(`SELECT
    COUNT(*) FILTER (WHERE book='actionable' AND status IN ('won','lost','closed','liquidated'))::int actionable_resolved_calls,
    COUNT(*) FILTER (WHERE book='research' AND status IN ('won','lost','closed','liquidated'))::int research_resolved_calls,
    COUNT(*) FILTER (WHERE book='actionable' AND status='won')::int actionable_wins,
    COUNT(*) FILTER (WHERE book='actionable' AND status IN ('lost','liquidated'))::int actionable_losses,
    COUNT(*) FILTER (WHERE book='research' AND status='won')::int research_wins,
    COUNT(*) FILTER (WHERE book='research' AND status IN ('lost','liquidated'))::int research_losses,
    COALESCE(SUM(net_pnl_usd) FILTER (
      WHERE book='actionable' AND status IN ('won','lost','closed','liquidated')
    ),0) actionable_realized_pnl,
    COALESCE(SUM(net_pnl_usd) FILTER (
      WHERE book='research' AND status IN ('won','lost','closed','liquidated')
    ),0) research_realized_pnl,
    COALESCE(SUM(margin_usd) FILTER (
      WHERE book='actionable' AND status IN ('won','lost','closed','liquidated')
    ),0) actionable_resolved_margin,
    COALESCE(SUM(margin_usd) FILTER (
      WHERE book='research' AND status IN ('won','lost','closed','liquidated')
    ),0) research_resolved_margin
    FROM btc_paper_calls`);
  const row = result.rows[0] || {};
  return {
    actionableResolvedCalls: number(row.actionable_resolved_calls),
    researchResolvedCalls: number(row.research_resolved_calls),
    actionableWins: number(row.actionable_wins),
    actionableLosses: number(row.actionable_losses),
    researchWins: number(row.research_wins),
    researchLosses: number(row.research_losses),
    actionableRealizedPnlUsd: number(row.actionable_realized_pnl),
    researchRealizedPnlUsd: number(row.research_realized_pnl),
    actionableResolvedMarginUsd: number(row.actionable_resolved_margin),
    researchResolvedMarginUsd: number(row.research_resolved_margin),
  };
}

export async function actionableDayStats(): Promise<{ callsToday: number; realizedPnlToday: number }> {
  if (!pool) return { callsToday: 0, realizedPnlToday: 0 };
  const result = await pool.query(`SELECT
    COUNT(*) FILTER (
      WHERE opened_at >= date_trunc('day',now() AT TIME ZONE 'America/Chicago') AT TIME ZONE 'America/Chicago'
    )::int calls_today,
    COALESCE(SUM(net_pnl_usd) FILTER (
      WHERE status IN ('won','lost','closed','liquidated')
        AND closed_at >= date_trunc('day',now() AT TIME ZONE 'America/Chicago') AT TIME ZONE 'America/Chicago'
    ),0) realized_pnl
    FROM btc_paper_calls WHERE book='actionable'`);
  return { callsToday: number(result.rows[0]?.calls_today), realizedPnlToday: number(result.rows[0]?.realized_pnl) };
}
