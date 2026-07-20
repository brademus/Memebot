import { cfg } from '../config';
import { pool } from '../db';

const numberOrNull = (value: unknown): number | null => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const objectOrEmpty = (value: unknown): Record<string, any> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};

function setupFor(row: any): string {
  const entry = objectOrEmpty(row.entry_context);
  const token = objectOrEmpty(row.token_snapshot || entry.token);
  const identity = objectOrEmpty(token.identity);
  const source = String(row.token_source || identity.source || 'unknown');
  const playType = String(identity.playType || 'unknown');
  if (source === 'aged' && playType === 'RUNNER') return 'post_grad_continuation';
  if (source === 'aged' && playType === 'REVIVAL') return 'established_revival';
  return playType !== 'unknown' ? playType.toLowerCase() : source;
}

function reasonsFor(row: any): string[] {
  const entry = objectOrEmpty(row.entry_context);
  const token = objectOrEmpty(row.token_snapshot || entry.token);
  const identity = objectOrEmpty(token.identity);
  const conviction = objectOrEmpty(row.conviction_snapshot || entry.conviction);
  const trigger = objectOrEmpty(row.trigger_snapshot || entry.triggerAssessment);
  const rank = objectOrEmpty(row.rank_snapshot);
  const decision = objectOrEmpty(row.signal_decision || token.modelDecision);
  const reasons: string[] = [];
  if (row.signal) reasons.push(`Recorded signal: ${row.signal}`);
  if (identity.source) reasons.push(`Discovery source: ${identity.source}`);
  if (identity.playType) reasons.push(`Setup/play type: ${identity.playType}`);
  if (conviction.lane) reasons.push(`Conviction lane: ${conviction.lane}`);
  if (conviction.label) reasons.push(`Conviction evidence: ${conviction.label}`);
  if (trigger.reason) reasons.push(`Trigger reason: ${trigger.reason}`);
  if (Array.isArray(trigger.reasons)) reasons.push(...trigger.reasons.map((reason: unknown) => `Trigger evidence: ${String(reason)}`));
  if (decision.allow === true) reasons.push('Signal Stack decision: allowed');
  if (decision.preliminary_pass === true || decision.preliminaryPass === true) reasons.push('Signal Stack preliminary pass: yes');
  if (Array.isArray(decision.reasons)) reasons.push(...decision.reasons.map((reason: unknown) => `Model evidence: ${String(reason)}`));
  if (rank.grade) reasons.push(`Recorded rank grade: ${rank.grade}`);
  if (rank.timing) reasons.push(`Recorded entry timing: ${rank.timing}`);
  if (rank.label) reasons.push(`Recorded rank label: ${rank.label}`);
  if (row.entry_score !== null && row.entry_score !== undefined) reasons.push(`Entry score: ${row.entry_score}`);
  return [...new Set(reasons)];
}

function compactTrade(row: any) {
  const entry = objectOrEmpty(row.entry_context);
  const exit = objectOrEmpty(row.exit_context);
  const token = objectOrEmpty(row.token_snapshot || entry.token);
  const decision = objectOrEmpty(row.signal_decision || token.modelDecision);
  const pnlPct = numberOrNull(row.pnl_pct);
  return {
    tradeId: Number(row.id),
    contractAddress: row.ca,
    symbol: row.symbol,
    setup: setupFor(row),
    status: row.closed ? row.exit_reason === 'tracking_lost' ? 'tracking_lost' : 'closed' : 'open',
    entry: {
      at: row.entry_at,
      signal: row.signal,
      modelVersion: row.model_version,
      price: numberOrNull(row.entry_price),
      markPrice: numberOrNull(row.mark_entry_price),
      score: numberOrNull(row.entry_score),
      recordedReasons: reasonsFor(row),
      completeContext: row.entry_context,
      conviction: row.conviction_snapshot || entry.conviction || null,
      triggerAssessment: row.trigger_snapshot || entry.triggerAssessment || null,
      rank: row.rank_snapshot,
      features: row.feature_snapshot,
      burst: row.burst_snapshot,
      tokenSnapshot: token,
      coverage: row.coverage_snapshot,
      stream: row.stream_snapshot,
      configAtEntry: row.config_snapshot,
    },
    decision: {
      linkedDecisionId: row.signal_decision_id ? Number(row.signal_decision_id) : null,
      fullRecord: Object.keys(decision).length ? decision : null,
    },
    execution: {
      eligible: !!row.execution_eligible,
      quoteStatus: row.quote_status,
      quoteAttemptedAt: row.quote_attempted_at,
      quoteKeyPresent: row.quote_key_present,
      transactionBuilt: !!row.transaction_built,
      simulationOk: !!row.simulation_ok,
      simulationError: row.simulation_error,
      executionScore: numberOrNull(row.execution_score),
      routeStabilityBps: numberOrNull(row.route_stability_bps),
      router: row.router,
      positionSol: numberOrNull(row.position_sol),
      positionUsd: numberOrNull(row.position_usd),
      quotedOutUsd: numberOrNull(row.quoted_out_usd),
      priceImpactPct: numberOrNull(row.price_impact_pct),
      slippageBps: numberOrNull(row.slippage_bps),
      feeLamports: numberOrNull(row.fee_lamports),
      quoteTimeMs: numberOrNull(row.quote_time_ms),
      completeProbe: row.execution_probe,
    },
    exit: {
      sold: !!row.closed,
      at: row.exit_at,
      price: numberOrNull(row.exit_price),
      reason: row.exit_reason,
      completeContext: row.exit_context,
      quoteStatus: row.exit_quote_status,
      transactionBuilt: !!row.exit_transaction_built,
      simulationOk: !!row.exit_simulation_ok,
      simulationError: row.exit_simulation_error,
      quotedUsd: numberOrNull(row.exit_quoted_usd),
      priceImpactPct: numberOrNull(row.exit_price_impact_pct),
      feeLamports: numberOrNull(row.exit_fee_lamports),
      router: row.exit_router,
      quoteTimeMs: numberOrNull(row.exit_quote_time_ms),
    },
    outcome: {
      finalMultiple: numberOrNull(row.final_multiple),
      pnlPct,
      normalizedPnlUsdOn100: pnlPct,
      peakPrice: numberOrNull(row.peak_price),
      peakAt: row.peak_at,
      troughPrice: numberOrNull(row.trough_price),
      troughAt: row.trough_at,
      maxRunupPct: numberOrNull(row.max_runup_pct),
      maxDrawdownPct: numberOrNull(row.max_drawdown_pct),
      durationSeconds: numberOrNull(row.duration_seconds),
      targetMultiple: numberOrNull(row.target_multiple),
      observedTargetHitAt: row.observed_target_hit_at,
      executableTargetHitAt: row.target_hit_at,
      secondsToTarget: numberOrNull(row.seconds_to_target),
    },
    evidenceCoverage: {
      snapshotCount: Number(row.snapshot_count) || 0,
      lifecycleEventCount: Number(row.event_count) || 0,
      exactTradeEventsAtEntry: Number(row.exact_trade_events_at_entry) || 0,
      exactTradeEventsDuringCall: Number(row.exact_trade_events_during_call) || 0,
      hasEntryContext: !!row.entry_context,
      hasRequiredExitContext: !row.closed || !!row.exit_context,
      hasLinkedSignalDecision: !!row.signal_decision_id,
    },
    rawDatabaseRecord: row,
    exitSummary: row.closed
      ? `Closed at ${row.exit_at || 'unknown time'} because ${row.exit_reason || exit.reason || 'no reason was recorded'}.`
      : 'Still open; no sale/close has been recorded.',
  };
}

export async function buildHistoricalReview() {
  if (!pool) return { allTimeTradeLedger: [], historicalReviewNote: 'No database attached.' };
  const errors: string[] = [];
  const query = async (name: string, sql: string, parameters: unknown[] = []): Promise<any[]> => {
    try { return (await pool!.query(sql, parameters)).rows; }
    catch (error) {
      errors.push(`${name}: ${(error as Error).message}`);
      return [];
    }
  };

  const rows = await query('all-time trade ledger', `SELECT p.*,t.source AS token_source,t.name AS token_name,
      t.creator,t.first_seen AS token_first_seen,t.gate_result,t.gate_fail_reason,t.deployer_rep,t.insider_pct,
      t.insider_cluster_pct,t.regime_id,CASE WHEN d.id IS NULL THEN NULL ELSE to_jsonb(d) END AS signal_decision
    FROM paper_trades p LEFT JOIN tokens t ON t.ca=p.ca
    LEFT JOIN signal_decisions d ON d.id=p.signal_decision_id ORDER BY p.entry_at`);

  const setupSamples = await query('executable samples by setup', `WITH calls AS (
      SELECT p.*,COALESCE(t.source,'unknown') AS source,
        COALESCE(p.token_snapshot#>>'{identity,playType}',p.entry_context#>>'{token,identity,playType}','unknown') AS play_type
      FROM paper_trades p LEFT JOIN tokens t ON t.ca=p.ca)
    SELECT CASE WHEN source='aged' AND play_type='RUNNER' THEN 'post_grad_continuation'
                WHEN source='aged' AND play_type='REVIVAL' THEN 'established_revival'
                WHEN play_type<>'unknown' THEN lower(play_type) ELSE source END AS setup,
      COUNT(*) FILTER (WHERE execution_eligible AND closed AND exit_reason IS DISTINCT FROM 'tracking_lost')::int AS resolved_executable,
      ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY final_multiple)
        FILTER (WHERE execution_eligible AND closed AND exit_reason IS DISTINCT FROM 'tracking_lost'))::numeric,3) AS median_final_multiple,
      ROUND((SUM(pnl_pct) FILTER (WHERE execution_eligible AND closed AND exit_reason IS DISTINCT FROM 'tracking_lost'))::numeric,2) AS normalized_pnl_usd_on_100_each
    FROM calls GROUP BY 1 ORDER BY 1`);

  const minimum = Number(cfg().paper.min_forward_samples_per_lane) || 100;
  const measuredSetups = setupSamples.filter(row => Number(row.resolved_executable) > 0);
  const everyMeasuredSetupReady = measuredSetups.length > 0
    && measuredSetups.every(row => Number(row.resolved_executable) >= minimum);
  const everyMeasuredSetupPositive = measuredSetups.length > 0
    && measuredSetups.every(row => Number(row.median_final_multiple) > 1
      && Number(row.normalized_pnl_usd_on_100_each) > 0);

  return {
    allTimeTradeLedger: rows.map(compactTrade),
    historicalTradeCount: rows.length,
    profitabilityReadinessBySetup: {
      minimumResolvedExecutableCallsPerSetup: minimum,
      setupSamples,
      everyMeasuredSetupReady,
      everyMeasuredSetupPositive,
      status: !everyMeasuredSetupReady ? 'insufficient_executable_sample_by_setup'
        : everyMeasuredSetupPositive ? 'positive_paper_evidence_by_setup_not_live_proven'
          : 'one_or_more_setups_not_profitable_in_resolved_executable_sample',
      warning: 'Only resolved, execution-eligible paper calls count toward promotion readiness. Paper evidence does not establish live profitability.',
    },
    historicalReviewErrors: errors,
  };
}
