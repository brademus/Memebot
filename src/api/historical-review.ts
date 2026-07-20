import { createHash } from 'node:crypto';
import { cfg } from '../config';
import { pool } from '../db';

const numberOrNull = (value: unknown): number | null => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const objectOrEmpty = (value: unknown): Record<string, any> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};

export function configSnapshotId(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 12);
}

function setupFor(row: any): string {
  const source = String(row.token_source || 'unknown');
  const playType = String(row.play_type || 'unknown');
  if (source === 'aged' && playType === 'RUNNER') return 'post_grad_continuation';
  if (source === 'aged' && playType === 'REVIVAL') return 'established_revival';
  return playType !== 'unknown' ? playType.toLowerCase() : source;
}

function reasonsFor(row: any): string[] {
  const conviction = objectOrEmpty(row.conviction_snapshot);
  const trigger = objectOrEmpty(row.trigger_snapshot);
  const rank = objectOrEmpty(row.rank_snapshot);
  const decision = objectOrEmpty(row.signal_decision);
  const reasons: string[] = [];
  if (row.signal) reasons.push(`Recorded signal: ${row.signal}`);
  if (row.token_source) reasons.push(`Discovery source: ${row.token_source}`);
  if (row.play_type && row.play_type !== 'unknown') reasons.push(`Setup/play type: ${row.play_type}`);
  if (conviction.lane) reasons.push(`Conviction lane: ${conviction.lane}`);
  if (conviction.label) reasons.push(`Conviction evidence: ${conviction.label}`);
  if (trigger.reason) reasons.push(`Trigger reason: ${trigger.reason}`);
  if (Array.isArray(trigger.reasons)) reasons.push(...trigger.reasons.map((reason: unknown) => `Trigger evidence: ${String(reason)}`));
  if (decision.allow === true) reasons.push('Signal Stack decision: allowed');
  if (decision.preliminaryPass === true) reasons.push('Signal Stack preliminary pass: yes');
  if (Array.isArray(decision.reasons)) reasons.push(...decision.reasons.map((reason: unknown) => `Model evidence: ${String(reason)}`));
  if (rank.grade) reasons.push(`Recorded rank grade: ${rank.grade}`);
  if (rank.timing) reasons.push(`Recorded entry timing: ${rank.timing}`);
  if (rank.label) reasons.push(`Recorded rank label: ${rank.label}`);
  if (row.entry_score !== null && row.entry_score !== undefined) reasons.push(`Entry score: ${row.entry_score}`);
  return [...new Set(reasons)];
}

export function compactHistoricalTrade(row: any, snapshotId = configSnapshotId(row.config_snapshot)) {
  const decision = objectOrEmpty(row.signal_decision);
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
      marketAgeHours: numberOrNull(objectOrEmpty(row.entry_lifecycle).marketAgeHours),
      recordedReasons: reasonsFor(row),
      lifecycle: row.entry_lifecycle || null,
      conviction: row.conviction_snapshot || null,
      triggerAssessment: row.trigger_snapshot || null,
      rank: row.rank_snapshot || null,
      coverage: row.coverage_snapshot || null,
      stream: row.stream_snapshot || null,
      configSnapshotId: snapshotId,
    },
    decision: {
      linkedDecisionId: row.signal_decision_id ? Number(row.signal_decision_id) : null,
      allow: decision.allow ?? null,
      preliminaryPass: decision.preliminaryPass ?? null,
      reasons: decision.reasons ?? null,
      regimeId: decision.regimeId ?? null,
      baseScore: numberOrNull(decision.baseScore),
      alphaScore: numberOrNull(decision.alphaScore),
      cohortPercentile: numberOrNull(decision.cohortPercentile),
      cohortSize: numberOrNull(decision.cohortSize),
      targetBeforeStopProbability: numberOrNull(decision.targetBeforeStopProbability),
      downsideProbability: numberOrNull(decision.downsideProbability),
      expectedValue: numberOrNull(decision.expectedValue),
      uncertainty: numberOrNull(decision.uncertainty),
      hazards: decision.hazards ?? null,
    },
    execution: {
      eligible: !!row.execution_eligible,
      quoteStatus: row.quote_status,
      quoteAttemptedAt: row.quote_attempted_at,
      quoteKeyPresent: row.quote_key_present,
      transactionBuilt: !!row.transaction_built,
      simulationOk: !!row.simulation_ok,
      simulationError: row.simulation_error,
      simulationUnits: numberOrNull(row.simulation_units),
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
    },
    exit: {
      sold: !!row.closed,
      at: row.exit_at,
      price: numberOrNull(row.exit_price),
      reason: row.exit_reason,
      quoteStatus: row.exit_quote_status,
      quotedUsd: numberOrNull(row.exit_quoted_usd),
      transactionBuilt: !!row.exit_transaction_built,
      simulationOk: !!row.exit_simulation_ok,
      simulationError: row.exit_simulation_error,
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
      hasEntryContext: !!row.has_entry_context,
      hasRequiredExitContext: !row.closed || !!row.has_exit_context,
      hasLinkedSignalDecision: !!row.signal_decision_id,
    },
    exitSummary: row.closed
      ? `Closed at ${row.exit_at || 'unknown time'} because ${row.exit_reason || 'no reason was recorded'}.`
      : 'Still open; no sale/close has been recorded.',
  };
}

export async function buildHistoricalReview() {
  if (!pool) return { allTimeTradeLedger: [], historicalReviewNote: 'No database attached.' };
  const errors: string[] = [];
  const query = async (name: string, sql: string, parameters: unknown[] = []): Promise<any[]> => {
    try { return (await pool!.query({ text: sql, values: parameters, query_timeout: 8000 } as any)).rows; }
    catch (error) {
      errors.push(`${name}: ${(error as Error).message}`);
      return [];
    }
  };

  const rows = await query('all-time trade ledger', `SELECT
      p.id,p.ca,p.symbol,p.signal,p.model_version,p.entry_at,p.entry_price,p.mark_entry_price,p.entry_score,
      p.execution_eligible,p.quote_status,p.quote_attempted_at,p.quote_key_present,p.transaction_built,
      p.simulation_ok,p.simulation_error,p.simulation_units,p.route_stability_bps,p.execution_score,
      p.position_sol,p.position_usd,p.quoted_out_usd,p.price_impact_pct,p.slippage_bps,p.fee_lamports,
      p.router,p.quote_time_ms,p.closed,p.exit_at,p.exit_price,p.exit_reason,p.exit_quote_status,
      p.exit_quoted_usd,p.exit_transaction_built,p.exit_simulation_ok,p.exit_simulation_error,
      p.exit_price_impact_pct,p.exit_fee_lamports,p.exit_router,p.exit_quote_time_ms,p.final_multiple,
      p.pnl_pct,p.peak_price,p.peak_at,p.trough_price,p.trough_at,p.max_runup_pct,p.max_drawdown_pct,
      p.duration_seconds,p.target_multiple,p.observed_target_hit_at,p.target_hit_at,p.seconds_to_target,
      p.snapshot_count,p.event_count,p.exact_trade_events_at_entry,p.exact_trade_events_during_call,
      p.signal_decision_id,p.config_snapshot,p.conviction_snapshot,p.trigger_snapshot,p.rank_snapshot,
      p.coverage_snapshot,p.stream_snapshot,(p.entry_context IS NOT NULL) AS has_entry_context,
      (p.exit_context IS NOT NULL) AS has_exit_context,p.entry_context#>'{lifecycle}' AS entry_lifecycle,
      COALESCE(t.source,'unknown') AS token_source,
      COALESCE(p.token_snapshot#>>'{identity,playType}',p.entry_context#>>'{token,identity,playType}','unknown') AS play_type,
      CASE WHEN d.id IS NULL THEN NULL ELSE jsonb_build_object(
        'allow',d.allow,'preliminaryPass',d.preliminary_pass,'reasons',d.reasons,'regimeId',d.regime_id,
        'baseScore',d.base_score,'alphaScore',d.alpha_score,'cohortPercentile',d.cohort_percentile,
        'cohortSize',d.cohort_size,'targetBeforeStopProbability',d.target_before_stop_probability,
        'downsideProbability',d.downside_probability,'expectedValue',d.expected_value,
        'uncertainty',d.uncertainty,'hazards',d.hazards) END AS signal_decision
    FROM paper_trades p LEFT JOIN tokens t ON t.ca=p.ca
    LEFT JOIN signal_decisions d ON d.id=p.signal_decision_id ORDER BY p.entry_at`);

  const configSnapshotsById: Record<string, unknown> = {};
  const allTimeTradeLedger = rows.map(row => {
    const id = configSnapshotId(row.config_snapshot);
    if (id && !configSnapshotsById[id]) configSnapshotsById[id] = row.config_snapshot;
    return compactHistoricalTrade(row, id);
  });

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
    allTimeTradeLedger,
    historicalTradeCount: rows.length,
    historicalConfigSnapshotsById: configSnapshotsById,
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
    payloadPolicy: 'All historical calls are included once. Large raw token, config, execution-probe, and exit-context blobs are not duplicated per trade; config snapshots are deduplicated by ID.',
  };
}
