import { cfg } from '../config';
import { pool } from '../db';
import { heliusHealth } from '../helius';
import { agedDiag } from '../ingest/aged';
import { momentumDiag } from '../ingest/momentum';
import { pumpfunStreamDiag } from '../ingest/pumpfun';
import { socialDiag } from '../ingest/social';
import { MODEL_VERSION } from '../model/version';
import { getMissedWinners } from '../outcomes/missed';
import { paperDiag } from '../paper/paper';
import { paperTelemetryDiag } from '../paper/telemetry';
import { discoveryDiag } from '../wallets/discovery';
import { webhookDiag } from '../wallets/webhook';
import { winnerMinerDiag } from '../wallets/winnerminer';

const asNumber = (value: unknown): number | null => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const asObject = (value: unknown): Record<string, any> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};

const groupBy = <T>(rows: T[], key: (row: T) => string): Record<string, T[]> => {
  const grouped: Record<string, T[]> = {};
  for (const row of rows) (grouped[key(row)] ||= []).push(row);
  return grouped;
};

function recordedEntryReasons(row: any): string[] {
  const entry = asObject(row.entry_context);
  const conviction = asObject(row.conviction_snapshot || entry.conviction);
  const trigger = asObject(row.trigger_snapshot || entry.triggerAssessment);
  const rank = asObject(row.rank_snapshot);
  const decision = asObject(row.signal_decision || row.model_decision);
  const token = asObject(row.token_snapshot || entry.token);
  const identity = asObject(token.identity);
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

function tradeSetup(row: any): string {
  const entry = asObject(row.entry_context);
  const token = asObject(row.token_snapshot || entry.token);
  const identity = asObject(token.identity);
  const source = String(row.token_source || identity.source || 'unknown');
  const playType = String(identity.playType || 'unknown');
  if (source === 'aged' && playType === 'RUNNER') return 'post_grad_continuation';
  if (source === 'aged' && playType === 'REVIVAL') return 'established_revival';
  if (playType !== 'unknown') return playType.toLowerCase();
  return source;
}

function normalizeTrade(row: any, snapshots: any[], events: any[], wallets: any[], aiConviction: any | null) {
  const entry = asObject(row.entry_context);
  const exit = asObject(row.exit_context);
  const token = asObject(row.token_snapshot || entry.token);
  const lifecycle = asObject(entry.lifecycle);
  const decision = asObject(row.signal_decision || token.modelDecision);
  const finalMultiple = asNumber(row.final_multiple);
  const pnlPct = asNumber(row.pnl_pct);
  const status = row.closed
    ? row.exit_reason === 'tracking_lost' ? 'tracking_lost' : 'closed'
    : 'open';

  return {
    tradeId: Number(row.id),
    contractAddress: row.ca,
    symbol: row.symbol,
    setup: tradeSetup(row),
    status,
    openedDuringDailyWindow: !!row.opened_during_window,
    closedDuringDailyWindow: !!row.closed_during_window,
    entry: {
      at: row.entry_at,
      signal: row.signal,
      modelVersion: row.model_version,
      price: asNumber(row.entry_price),
      markPrice: asNumber(row.mark_entry_price),
      score: asNumber(row.entry_score),
      marketAgeHours: asNumber(lifecycle.marketAgeHours),
      recordedReasons: recordedEntryReasons(row),
      lifecycle,
      conviction: row.conviction_snapshot || entry.conviction || null,
      triggerAssessment: row.trigger_snapshot || entry.triggerAssessment || null,
      rank: row.rank_snapshot,
      legacyFeatures: row.feature_snapshot,
      burst: row.burst_snapshot,
      tokenSnapshot: token,
      coverage: row.coverage_snapshot,
      stream: row.stream_snapshot,
      config: row.config_snapshot,
      completeEntryContext: row.entry_context,
    },
    decision: {
      linkedDecisionId: row.signal_decision_id ? Number(row.signal_decision_id) : null,
      allow: decision.allow ?? null,
      preliminaryPass: decision.preliminary_pass ?? decision.preliminaryPass ?? null,
      reasons: decision.reasons ?? null,
      regime: decision.regime_id ?? decision.regime ?? row.regime_id ?? null,
      baseScore: asNumber(decision.base_score ?? decision.baseScore),
      alphaScore: asNumber(decision.alpha_score ?? decision.alphaScore),
      cohortPercentile: asNumber(decision.cohort_percentile ?? decision.cohortPercentile),
      cohortSize: asNumber(decision.cohort_size ?? decision.cohortSize),
      targetBeforeStopProbability: asNumber(decision.target_before_stop_probability ?? decision.targetBeforeStopProbability),
      downsideProbability: asNumber(decision.downside_probability ?? decision.downsideProbability),
      expectedValue: asNumber(decision.expected_value ?? decision.expectedValue),
      uncertainty: asNumber(decision.uncertainty),
      hazards: decision.hazards ?? null,
      features: decision.features ?? null,
      fullDecisionRecord: Object.keys(decision).length ? decision : null,
      aiConviction,
      walletEvidence: wallets,
    },
    execution: {
      eligible: !!row.execution_eligible,
      quoteStatus: row.quote_status,
      quoteAttemptedAt: row.quote_attempted_at,
      quoteKeyPresent: row.quote_key_present,
      transactionBuilt: !!row.transaction_built,
      simulationOk: !!row.simulation_ok,
      simulationError: row.simulation_error,
      simulationUnits: asNumber(row.simulation_units),
      executionScore: asNumber(row.execution_score),
      routeStabilityBps: asNumber(row.route_stability_bps),
      router: row.router,
      positionSol: asNumber(row.position_sol),
      positionUsd: asNumber(row.position_usd),
      quotedOutUsd: asNumber(row.quoted_out_usd),
      quotedOutAmount: asNumber(row.quoted_out_amount),
      priceImpactPct: asNumber(row.price_impact_pct),
      slippageBps: asNumber(row.slippage_bps),
      feeLamports: asNumber(row.fee_lamports),
      quoteTimeMs: asNumber(row.quote_time_ms),
      completeProbe: row.execution_probe,
    },
    exit: {
      sold: !!row.closed,
      at: row.exit_at,
      price: asNumber(row.exit_price),
      reason: row.exit_reason,
      completeExitContext: row.exit_context,
      quoteStatus: row.exit_quote_status,
      quotedUsd: asNumber(row.exit_quoted_usd),
      transactionBuilt: !!row.exit_transaction_built,
      simulationOk: !!row.exit_simulation_ok,
      simulationError: row.exit_simulation_error,
      priceImpactPct: asNumber(row.exit_price_impact_pct),
      feeLamports: asNumber(row.exit_fee_lamports),
      router: row.exit_router,
      quoteTimeMs: asNumber(row.exit_quote_time_ms),
    },
    outcome: {
      finalMultiple,
      pnlPct,
      normalizedPnlUsdOn100: pnlPct,
      peakPrice: asNumber(row.peak_price),
      peakAt: row.peak_at,
      peakMultiple: row.entry_price && row.peak_price ? Number(row.peak_price) / Number(row.entry_price) : null,
      troughPrice: asNumber(row.trough_price),
      troughAt: row.trough_at,
      troughMultiple: row.entry_price && row.trough_price ? Number(row.trough_price) / Number(row.entry_price) : null,
      maxRunupPct: asNumber(row.max_runup_pct),
      maxDrawdownPct: asNumber(row.max_drawdown_pct),
      durationSeconds: asNumber(row.duration_seconds),
      observedTargetHitAt: row.observed_target_hit_at,
      executableTargetHitAt: row.target_hit_at,
      secondsToTarget: asNumber(row.seconds_to_target),
      targetMultiple: asNumber(row.target_multiple),
    },
    evidenceCoverage: {
      snapshotCount: Number(row.snapshot_count) || 0,
      lifecycleEventCount: Number(row.event_count) || 0,
      exactTradeEventsAtEntry: Number(row.exact_trade_events_at_entry) || 0,
      exactTradeEventsDuringCall: Number(row.exact_trade_events_during_call) || 0,
      hasEntryContext: !!row.entry_context,
      hasExitContext: !row.closed || !!row.exit_context,
      hasLinkedSignalDecision: !!row.signal_decision_id,
      hasMarketPath: snapshots.length > 0,
      hasLifecycleLedger: events.length > 0,
    },
    marketPath: snapshots,
    lifecycleLedger: events,
    rawDatabaseRecord: row,
    exitSummary: row.closed
      ? `Closed at ${row.exit_at || 'unknown time'} because ${row.exit_reason || exit.reason || 'no reason was recorded'}.`
      : 'Still open; no sale/close has been recorded.',
  };
}

function readiness(summary: any) {
  const resolved = Number(summary?.resolved_calls) || 0;
  const minimum = Number(cfg().paper.min_forward_samples_per_lane) || 100;
  const median = asNumber(summary?.median_final_multiple);
  const normalizedPnl = asNumber(summary?.normalized_pnl_usd_on_100_each);
  const enoughEvidence = resolved >= minimum;
  const observedPositive = (median ?? 0) > 1 && (normalizedPnl ?? 0) > 0;
  return {
    status: !enoughEvidence ? 'insufficient_sample'
      : observedPositive ? 'positive_paper_evidence_not_live_proven'
        : 'not_profitable_in_resolved_paper_sample',
    resolvedExecutableCalls: resolved,
    minimumResolvedCallsBeforePromotionReview: minimum,
    enoughEvidence,
    observedPositive,
    warning: 'Paper results and quote/simulation evidence do not prove future or live profitability. Do not enable live execution from this report alone.',
  };
}

export async function buildMasterReview(days = 1) {
  const generated = new Date().toISOString();
  const boundedDays = Math.max(1, Math.min(7, days));
  if (!pool) return {
    reportType: 'daily_master_review', generated, dailyWindow: `last ${boundedDays} day(s)`,
    note: 'No database attached; complete trade and outcome evidence is unavailable.',
  };

  const errors: string[] = [];
  const query = async (name: string, sql: string, parameters: unknown[] = []): Promise<any[]> => {
    try { return (await pool!.query(sql, parameters)).rows; }
    catch (error) {
      errors.push(`${name}: ${(error as Error).message}`);
      return [];
    }
  };
  const windowParameter = String(boundedDays);

  const trades = await query('daily trade ledger', `SELECT p.*,t.source AS token_source,t.name AS token_name,t.creator,
      t.first_seen AS token_first_seen,t.gate_result,t.gate_fail_reason,t.peak_score AS token_peak_score,
      t.last_state AS token_last_state,t.last_score AS token_last_score,t.deployer_rep,t.insider_pct,
      t.insider_cluster_pct,t.conviction_at AS token_conviction_at,t.triggered_at AS token_triggered_at,
      t.regime_id,CASE WHEN d.id IS NULL THEN NULL ELSE to_jsonb(d) END AS signal_decision,
      (p.entry_at>now()-($1||' days')::interval) AS opened_during_window,
      (p.exit_at>now()-($1||' days')::interval) AS closed_during_window
    FROM paper_trades p LEFT JOIN tokens t ON t.ca=p.ca
    LEFT JOIN signal_decisions d ON d.id=p.signal_decision_id
    WHERE p.entry_at>now()-($1||' days')::interval
       OR p.exit_at>now()-($1||' days')::interval OR p.closed=false
    ORDER BY p.entry_at`, [windowParameter]);

  const tradeIds = trades.map(row => Number(row.id)).filter(Number.isFinite);
  const contracts = [...new Set(trades.map(row => String(row.ca)).filter(Boolean))];
  const snapshots = tradeIds.length ? await query('trade snapshots',
    `SELECT * FROM paper_trade_snapshots WHERE paper_trade_id=ANY($1::bigint[]) ORDER BY paper_trade_id,captured_at`, [tradeIds]) : [];
  const events = tradeIds.length ? await query('trade lifecycle events',
    `SELECT * FROM paper_trade_events WHERE paper_trade_id=ANY($1::bigint[]) ORDER BY paper_trade_id,at,id`, [tradeIds]) : [];
  const walletRows = contracts.length ? await query('wallet evidence',
    `SELECT h.ca,h.wallet,h.at,h.buy_at,h.buy_price,w.type,w.quality_verdict,w.win_rate,w.round_trips,
            w.winners_hit,w.discovered_from,w.last_active
       FROM wallet_hits h LEFT JOIN smart_wallets w ON w.wallet=h.wallet
      WHERE h.ca=ANY($1::text[]) ORDER BY h.ca,h.buy_at`, [contracts]) : [];
  const aiRows = contracts.length ? await query('AI conviction evidence',
    `SELECT * FROM ai_conviction WHERE ca=ANY($1::text[])`, [contracts]) : [];

  const snapshotsByTrade = groupBy(snapshots, row => String((row as any).paper_trade_id));
  const eventsByTrade = groupBy(events, row => String((row as any).paper_trade_id));
  const walletsByContract = groupBy(walletRows, row => String((row as any).ca));
  const aiByContract = new Map(aiRows.map(row => [String(row.ca), row]));
  const tradeLedger = trades.map(row => normalizeTrade(
    row,
    snapshotsByTrade[String(row.id)] || [],
    eventsByTrade[String(row.id)] || [],
    walletsByContract[String(row.ca)] || [],
    aiByContract.get(String(row.ca)) || null,
  ));

  const dailyTradeSummary = (await query('daily trade summary', `SELECT
      COUNT(*) FILTER (WHERE entry_at>now()-($1||' days')::interval)::int AS opened,
      COUNT(*) FILTER (WHERE exit_at>now()-($1||' days')::interval)::int AS closed,
      COUNT(*) FILTER (WHERE NOT closed)::int AS currently_open,
      COUNT(*) FILTER (WHERE exit_at>now()-($1||' days')::interval AND exit_reason='tracking_lost')::int AS tracking_lost,
      COUNT(*) FILTER (WHERE entry_at>now()-($1||' days')::interval AND execution_eligible)::int AS executable_opened,
      COUNT(*) FILTER (WHERE exit_at>now()-($1||' days')::interval AND final_multiple>=3)::int AS closed_at_or_above_3x,
      ROUND((AVG(final_multiple) FILTER (WHERE exit_at>now()-($1||' days')::interval AND exit_reason IS DISTINCT FROM 'tracking_lost'))::numeric,3) AS avg_final_multiple,
      ROUND((SUM(pnl_pct) FILTER (WHERE exit_at>now()-($1||' days')::interval AND exit_reason IS DISTINCT FROM 'tracking_lost'))::numeric,2) AS normalized_pnl_usd_on_100_each
    FROM paper_trades`, [windowParameter]))[0] || {};

  const overall = (await query('overall trade summary', `SELECT COUNT(*)::int AS total_calls,
      COUNT(*) FILTER (WHERE execution_eligible)::int AS executable_calls,
      COUNT(*) FILTER (WHERE NOT closed)::int AS open_calls,
      COUNT(*) FILTER (WHERE closed)::int AS closed_calls,
      COUNT(*) FILTER (WHERE closed AND exit_reason IS DISTINCT FROM 'tracking_lost')::int AS resolved_calls,
      COUNT(*) FILTER (WHERE closed AND exit_reason='tracking_lost')::int AS tracking_lost,
      COUNT(*) FILTER (WHERE closed AND exit_reason IS DISTINCT FROM 'tracking_lost' AND final_multiple>=3)::int AS reached_3x,
      COUNT(*) FILTER (WHERE closed AND exit_reason IS DISTINCT FROM 'tracking_lost' AND final_multiple>=2)::int AS reached_2x,
      COUNT(*) FILTER (WHERE closed AND exit_reason IS DISTINCT FROM 'tracking_lost' AND final_multiple<=0.5)::int AS severe_losses,
      ROUND(100.0*COUNT(*) FILTER (WHERE closed AND exit_reason IS DISTINCT FROM 'tracking_lost' AND final_multiple>=3)
        /NULLIF(COUNT(*) FILTER (WHERE closed AND exit_reason IS DISTINCT FROM 'tracking_lost'),0),2) AS pct_3x,
      ROUND((AVG(final_multiple) FILTER (WHERE closed AND exit_reason IS DISTINCT FROM 'tracking_lost'))::numeric,3) AS avg_final_multiple,
      ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY final_multiple)
        FILTER (WHERE closed AND exit_reason IS DISTINCT FROM 'tracking_lost'))::numeric,3) AS median_final_multiple,
      ROUND((AVG(pnl_pct) FILTER (WHERE closed AND exit_reason IS DISTINCT FROM 'tracking_lost'))::numeric,2) AS avg_pnl_pct,
      ROUND((SUM(pnl_pct) FILTER (WHERE closed AND exit_reason IS DISTINCT FROM 'tracking_lost'))::numeric,2) AS normalized_pnl_usd_on_100_each
    FROM paper_trades`))[0] || {};

  const performanceBySetup = await query('performance by setup', `WITH calls AS (
      SELECT p.*,COALESCE(t.source,'unknown') AS source,
        COALESCE(p.token_snapshot#>>'{identity,playType}',p.entry_context#>>'{token,identity,playType}','unknown') AS play_type
      FROM paper_trades p LEFT JOIN tokens t ON t.ca=p.ca)
    SELECT CASE WHEN source='aged' AND play_type='RUNNER' THEN 'post_grad_continuation'
                WHEN source='aged' AND play_type='REVIVAL' THEN 'established_revival'
                WHEN play_type<>'unknown' THEN lower(play_type) ELSE source END AS setup,
      COUNT(*)::int AS calls,COUNT(*) FILTER (WHERE execution_eligible)::int AS executable,
      COUNT(*) FILTER (WHERE closed AND exit_reason IS DISTINCT FROM 'tracking_lost')::int AS resolved,
      COUNT(*) FILTER (WHERE closed AND exit_reason IS DISTINCT FROM 'tracking_lost' AND final_multiple>=3)::int AS reached_3x,
      ROUND((AVG(final_multiple) FILTER (WHERE closed AND exit_reason IS DISTINCT FROM 'tracking_lost'))::numeric,3) AS avg_final_multiple,
      ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY final_multiple)
        FILTER (WHERE closed AND exit_reason IS DISTINCT FROM 'tracking_lost'))::numeric,3) AS median_final_multiple,
      ROUND((SUM(pnl_pct) FILTER (WHERE closed AND exit_reason IS DISTINCT FROM 'tracking_lost'))::numeric,2) AS normalized_pnl_usd_on_100_each
    FROM calls GROUP BY 1 ORDER BY calls DESC`);

  const performanceBySource = await query('performance by source', `SELECT COALESCE(t.source,'unknown') AS source,
      COUNT(*)::int AS calls,COUNT(*) FILTER (WHERE p.execution_eligible)::int AS executable,
      COUNT(*) FILTER (WHERE p.closed AND p.exit_reason IS DISTINCT FROM 'tracking_lost')::int AS resolved,
      COUNT(*) FILTER (WHERE p.closed AND p.exit_reason IS DISTINCT FROM 'tracking_lost' AND p.final_multiple>=3)::int AS reached_3x,
      ROUND((AVG(p.final_multiple) FILTER (WHERE p.closed AND p.exit_reason IS DISTINCT FROM 'tracking_lost'))::numeric,3) AS avg_final_multiple,
      ROUND((SUM(p.pnl_pct) FILTER (WHERE p.closed AND p.exit_reason IS DISTINCT FROM 'tracking_lost'))::numeric,2) AS normalized_pnl_usd_on_100_each
    FROM paper_trades p LEFT JOIN tokens t ON t.ca=p.ca GROUP BY 1 ORDER BY calls DESC`);

  const performanceBySignal = await query('performance by signal', `SELECT signal,model_version,COUNT(*)::int AS calls,
      COUNT(*) FILTER (WHERE execution_eligible)::int AS executable,
      COUNT(*) FILTER (WHERE closed AND exit_reason IS DISTINCT FROM 'tracking_lost')::int AS resolved,
      COUNT(*) FILTER (WHERE closed AND exit_reason IS DISTINCT FROM 'tracking_lost' AND final_multiple>=3)::int AS reached_3x,
      ROUND((AVG(final_multiple) FILTER (WHERE closed AND exit_reason IS DISTINCT FROM 'tracking_lost'))::numeric,3) AS avg_final_multiple,
      ROUND((SUM(pnl_pct) FILTER (WHERE closed AND exit_reason IS DISTINCT FROM 'tracking_lost'))::numeric,2) AS normalized_pnl_usd_on_100_each
    FROM paper_trades GROUP BY signal,model_version ORDER BY calls DESC`);

  const dataQuality = (await query('overall evidence completeness', `SELECT COUNT(*)::int AS calls,
      COUNT(*) FILTER (WHERE entry_context IS NOT NULL)::int AS with_entry_context,
      COUNT(*) FILTER (WHERE NOT closed OR exit_context IS NOT NULL)::int AS with_required_exit_context,
      COUNT(*) FILTER (WHERE snapshot_count>0)::int AS with_market_path,
      COUNT(*) FILTER (WHERE event_count>0)::int AS with_lifecycle_events,
      COUNT(*) FILTER (WHERE signal_decision_id IS NOT NULL)::int AS linked_signal_decisions,
      COUNT(*) FILTER (WHERE quote_attempted_at IS NOT NULL)::int AS quote_attempted,
      COUNT(*) FILTER (WHERE transaction_built)::int AS transaction_built,
      COUNT(*) FILTER (WHERE simulation_ok)::int AS simulation_ok,
      COUNT(*) FILTER (WHERE execution_eligible)::int AS execution_eligible,
      COUNT(*) FILTER (WHERE closed AND exit_reason='tracking_lost')::int AS tracking_lost
    FROM paper_trades`))[0] || {};

  const changeLog = {
    filterTuning: await query('filter tuning log', `SELECT * FROM filter_tuning_log
      WHERE at>now()-($1||' days')::interval ORDER BY at DESC`, [windowParameter]),
    weightTuning: await query('weight tuning log', `SELECT * FROM weight_tuning_log
      WHERE at>now()-($1||' days')::interval ORDER BY at DESC`, [windowParameter]),
    modelSuggestions: await query('model suggestions', `SELECT * FROM model_suggestions
      WHERE created_at>now()-($1||' days')::interval ORDER BY created_at DESC`, [windowParameter]),
    aiReviews: await query('AI review history', `SELECT * FROM ai_reviews
      WHERE at>now()-($1||' days')::interval ORDER BY at DESC`, [windowParameter]),
  };

  const missedOpportunities = await getMissedWinners().catch(error => ({ error: (error as Error).message }));

  return {
    reportType: 'daily_master_review',
    generated,
    currentModelVersion: MODEL_VERSION,
    dailyWindow: { days: boundedDays, description: `Entries, exits, and all still-open calls relevant to the last ${boundedDays} day(s).` },
    copyInstructions: 'Copy this entire JSON. It contains the daily operating evidence, cumulative results, full config, and every relevant trade with its complete recorded entry/exit evidence and market path.',
    dailyTradeSummary,
    overall: {
      tradeSummary: overall,
      profitabilityReadiness: readiness(overall),
      performanceBySetup,
      performanceBySource,
      performanceBySignal,
    },
    tradeLedger,
    missedOpportunities,
    evidenceCompleteness: dataQuality,
    runtimeHealth: {
      pumpfun: pumpfunStreamDiag(), aged: agedDiag(), momentum: momentumDiag(), social: socialDiag(),
      helius: heliusHealth(), walletDiscovery: discoveryDiag(), walletWebhook: webhookDiag(),
      winnerMiner: winnerMinerDiag(), paper: await paperDiag(), callTelemetry: await paperTelemetryDiag(),
    },
    changesDuringDailyWindow: changeLog,
    configInForce: cfg(),
    queryErrors: errors,
    interpretationRules: [
      'Every paper trade opened in the daily window, closed in the daily window, or still open is included in tradeLedger.',
      'recordedReasons are extracted only from persisted signal, conviction, trigger, rank, and model evidence; raw snapshots remain attached for verification.',
      'tracking_lost rows are excluded from profitability calculations rather than silently counted as wins or losses.',
      'normalizedPnlUsdOn100 treats every resolved call as a hypothetical $100 position for comparability.',
      'No private key is required and no live transaction broadcasting is enabled by this review.',
    ],
  };
}
