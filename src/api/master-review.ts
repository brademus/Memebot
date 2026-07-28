import { cfg } from '../config';
import { pool } from '../db';
import { heliusHealth } from '../helius';
import { agedDiag } from '../ingest/aged';
import { momentumDiag } from '../ingest/momentum';
import { pumpfunStreamDiag } from '../ingest/pumpfun';
import { socialDiag } from '../ingest/social';
import { MODEL_VERSION } from '../model/version';
import { paperDiag } from '../paper/paper';
import { paperTelemetryDiag } from '../paper/telemetry';
import { discoveryDiag } from '../wallets/discovery';
import { webhookDiag } from '../wallets/webhook';
import { winnerMinerDiag } from '../wallets/winnerminer';
import { configSnapshotId } from './historical-review';

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

const without = (value: unknown, keys: string[]) => {
  const object = { ...asObject(value) };
  for (const key of keys) delete object[key];
  return Object.keys(object).length ? object : null;
};

export function reviewMarketBucket(ageSeconds: number): number {
  if (ageSeconds < 10 * 60) return Math.floor(Math.max(0, ageSeconds) / 60);
  if (ageSeconds < 60 * 60) return 100 + Math.floor((ageSeconds - 10 * 60) / (5 * 60));
  if (ageSeconds < 4 * 60 * 60) return 200 + Math.floor((ageSeconds - 60 * 60) / (15 * 60));
  return 300 + Math.floor((ageSeconds - 4 * 60 * 60) / (60 * 60));
}

function recordedEntryReasons(row: any): string[] {
  const conviction = asObject(row.conviction_snapshot);
  const trigger = asObject(row.trigger_snapshot);
  const rank = asObject(row.rank_snapshot);
  const decision = asObject(row.signal_decision);
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

function tradeSetup(row: any): string {
  const source = String(row.token_source || 'unknown');
  const playType = String(row.play_type || 'unknown');
  if (source === 'aged' && playType === 'RUNNER') return 'post_grad_continuation';
  if (source === 'aged' && playType === 'REVIVAL') return 'established_revival';
  return playType !== 'unknown' ? playType.toLowerCase() : source;
}

function tokenEvidence(row: any) {
  return {
    identity: row.token_identity || null,
    timing: row.token_timing || null,
    market: row.token_market || null,
    flow: without(row.token_flow, ['uniqueBuyerSamples', 'recentTradeTail']),
    curve: without(row.token_curve, ['curveSamples']),
    scoring: row.token_scoring || null,
    safety: without(row.token_safety, ['earlyBuyers', 'earlyExited']),
    social: without(row.token_social, ['tgSamples']),
    smartMoney: without(row.token_smart_money, ['hits']),
    ai: row.token_ai || null,
  };
}

function normalizeTrade(row: any, snapshots: any[], events: any[], wallets: any[], aiConviction: any | null, snapshotId: string | null) {
  const decision = asObject(row.signal_decision);
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
      marketAgeHours: asNumber(asObject(row.entry_lifecycle).marketAgeHours),
      recordedReasons: recordedEntryReasons(row),
      lifecycle: row.entry_lifecycle || null,
      conviction: row.conviction_snapshot || null,
      triggerAssessment: row.trigger_snapshot || null,
      rank: row.rank_snapshot || null,
      legacyFeatures: row.feature_snapshot || null,
      burst: row.burst_snapshot || null,
      tokenEvidence: tokenEvidence(row),
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
      baseScore: asNumber(decision.baseScore),
      alphaScore: asNumber(decision.alphaScore),
      cohortPercentile: asNumber(decision.cohortPercentile),
      cohortSize: asNumber(decision.cohortSize),
      targetBeforeStopProbability: asNumber(decision.targetBeforeStopProbability),
      downsideProbability: asNumber(decision.downsideProbability),
      expectedValue: asNumber(decision.expectedValue),
      uncertainty: asNumber(decision.uncertainty),
      hazards: decision.hazards ?? null,
      features: decision.features ?? null,
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
    },
    exit: {
      sold: !!row.closed,
      at: row.exit_at,
      price: asNumber(row.exit_price),
      reason: row.exit_reason,
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
      snapshotCountRecorded: Number(row.snapshot_count) || 0,
      snapshotCountIncluded: snapshots.length,
      lifecycleEventCountRecorded: Number(row.event_count) || 0,
      lifecycleEventCountIncluded: events.length,
      exactTradeEventsAtEntry: Number(row.exact_trade_events_at_entry) || 0,
      exactTradeEventsDuringCall: Number(row.exact_trade_events_during_call) || 0,
      hasEntryContext: !!row.has_entry_context,
      hasExitContext: !row.closed || !!row.has_exit_context,
      hasLinkedSignalDecision: !!row.signal_decision_id,
      hasMarketPath: snapshots.length > 0,
      hasLifecycleLedger: events.length > 0,
    },
    marketPath: snapshots,
    lifecycleLedger: events,
    exitSummary: row.closed
      ? `Closed at ${row.exit_at || 'unknown time'} because ${row.exit_reason || 'no reason was recorded'}.`
      : 'Still open; no sale/close has been recorded.',
  };
}

export async function buildMasterReview(days = 3650) {
  const generated = new Date().toISOString();
  // ALL-TIME by default (user-directed 2026-07-28): the report covers everything the
  // bot has ever done. Aggregates, ledgers, and evidence sections span full history;
  // FULL per-trade telemetry is carried only for the most recent 7 days (the compact
  // all-time ledger lists every trade ever) so the archive stays buildable as
  // history grows instead of becoming a half-gigabyte file within weeks.
  const boundedDays = Math.max(1, Math.min(3650, days));
  // measured 2026-07-28: ONE day of full telemetry = 48.9 MB of JSON; seven days
  // would push the archive toward half a gigabyte and risk the builder's memory.
  // Two days keeps deep forensics for the freshest 48h at a buildable size; the
  // compact allTimeTradeLedger still lists every trade ever.
  const telemetryDays = Math.min(boundedDays, 2);
  if (!pool) return {
    reportType: 'all_time_master_review', generated, reportWindow: 'all time',
    note: 'No database attached; complete trade and outcome evidence is unavailable.',
  };

  const errors: string[] = [];
  const query = async (name: string, sql: string, parameters: unknown[] = []): Promise<any[]> => {
    try { return (await pool!.query({ text: sql, values: parameters, query_timeout: 8000 } as any)).rows; }
    catch (error) {
      errors.push(`${name}: ${(error as Error).message}`);
      return [];
    }
  };
  const windowParameter = String(boundedDays);

  const trades = await query('daily trade ledger', `SELECT
      p.id,p.ca,p.symbol,p.signal,p.model_version,p.entry_at,p.entry_price,p.mark_entry_price,p.entry_score,
      p.execution_eligible,p.quote_status,p.quote_attempted_at,p.quote_key_present,p.transaction_built,
      p.simulation_ok,p.simulation_error,p.simulation_units,p.route_stability_bps,p.execution_score,
      p.position_sol,p.position_usd,p.quoted_out_usd,p.quoted_out_amount,p.price_impact_pct,p.slippage_bps,
      p.fee_lamports,p.router,p.quote_time_ms,p.closed,p.exit_at,p.exit_price,p.exit_reason,p.exit_quote_status,
      p.exit_quoted_usd,p.exit_transaction_built,p.exit_simulation_ok,p.exit_simulation_error,
      p.exit_price_impact_pct,p.exit_fee_lamports,p.exit_router,p.exit_quote_time_ms,p.final_multiple,p.pnl_pct,
      p.peak_price,p.peak_at,p.trough_price,p.trough_at,p.max_runup_pct,p.max_drawdown_pct,p.duration_seconds,
      p.target_multiple,p.observed_target_hit_at,p.target_hit_at,p.seconds_to_target,p.snapshot_count,p.event_count,
      p.exact_trade_events_at_entry,p.exact_trade_events_during_call,p.signal_decision_id,p.config_snapshot,
      p.conviction_snapshot,p.trigger_snapshot,p.rank_snapshot,p.feature_snapshot,p.burst_snapshot,
      p.coverage_snapshot,p.stream_snapshot,(p.entry_context IS NOT NULL) AS has_entry_context,
      (p.exit_context IS NOT NULL) AS has_exit_context,p.entry_context#>'{lifecycle}' AS entry_lifecycle,
      p.token_snapshot#>'{identity}' AS token_identity,p.token_snapshot#>'{timing}' AS token_timing,
      p.token_snapshot#>'{market}' AS token_market,p.token_snapshot#>'{flow}' AS token_flow,
      p.token_snapshot#>'{curve}' AS token_curve,p.token_snapshot#>'{scoring}' AS token_scoring,
      p.token_snapshot#>'{safety}' AS token_safety,p.token_snapshot#>'{social}' AS token_social,
      p.token_snapshot#>'{smartMoney}' AS token_smart_money,p.token_snapshot#>'{ai}' AS token_ai,
      COALESCE(t.source,'unknown') AS token_source,
      COALESCE(p.token_snapshot#>>'{identity,playType}',p.entry_context#>>'{token,identity,playType}','unknown') AS play_type,
      CASE WHEN d.id IS NULL THEN NULL ELSE jsonb_build_object(
        'allow',d.allow,'preliminaryPass',d.preliminary_pass,'reasons',d.reasons,'regimeId',d.regime_id,
        'baseScore',d.base_score,'alphaScore',d.alpha_score,'cohortPercentile',d.cohort_percentile,
        'cohortSize',d.cohort_size,'targetBeforeStopProbability',d.target_before_stop_probability,
        'downsideProbability',d.downside_probability,'expectedValue',d.expected_value,
        'uncertainty',d.uncertainty,'hazards',d.hazards,'features',d.features) END AS signal_decision,
      (p.entry_at>now()-($1||' days')::interval) AS opened_during_window,
      (p.exit_at>now()-($1||' days')::interval) AS closed_during_window
    FROM paper_trades p LEFT JOIN tokens t ON t.ca=p.ca
    LEFT JOIN signal_decisions d ON d.id=p.signal_decision_id
    WHERE p.entry_at>now()-($1||' days')::interval
       OR p.exit_at>now()-($1||' days')::interval OR p.closed=false
    ORDER BY p.entry_at`, [String(telemetryDays)]);   // full telemetry: recent slice only

  const tradeIds = trades.map(row => Number(row.id)).filter(Number.isFinite);
  const contracts = [...new Set(trades.map(row => String(row.ca)).filter(Boolean))];
  const snapshots = tradeIds.length ? await query('downsampled trade snapshots', `WITH bucketed AS (
      SELECT paper_trade_id,captured_at,captured_age_seconds,phase,price_usd,multiple,peak_multiple,trough_multiple,
             runup_pct,drawdown_pct,liquidity_usd,mcap_usd,liquidity_mcap_ratio,vol_5m,buys_5m,sells_5m,
             buy_sell_ratio,total_buys,total_sells,unique_buyers,curve_sol,peak_curve_sol,score,peak_score,
             state,stream_mode,exact_trade_events,
             CASE WHEN captured_age_seconds<600 THEN floor(captured_age_seconds/60.0)::int
                  WHEN captured_age_seconds<3600 THEN 100+floor((captured_age_seconds-600)/300.0)::int
                  WHEN captured_age_seconds<14400 THEN 200+floor((captured_age_seconds-3600)/900.0)::int
                  ELSE 300+floor((captured_age_seconds-14400)/3600.0)::int END AS review_bucket
        FROM paper_trade_snapshots WHERE paper_trade_id=ANY($1::bigint[])), ranked AS (
      SELECT *,ROW_NUMBER() OVER (PARTITION BY paper_trade_id,review_bucket ORDER BY captured_at DESC) AS rn
        FROM bucketed)
    SELECT paper_trade_id,captured_at,captured_age_seconds,phase,price_usd,multiple,peak_multiple,trough_multiple,
           runup_pct,drawdown_pct,liquidity_usd,mcap_usd,liquidity_mcap_ratio,vol_5m,buys_5m,sells_5m,
           buy_sell_ratio,total_buys,total_sells,unique_buyers,curve_sol,peak_curve_sol,score,peak_score,
           state,stream_mode,exact_trade_events
      FROM ranked WHERE rn=1 ORDER BY paper_trade_id,captured_at`, [tradeIds]) : [];
  const events = tradeIds.length ? await query('compact trade lifecycle events',
    `SELECT paper_trade_id,event_type,dedupe_key,at,price_usd,multiple,state,reason
       FROM paper_trade_events WHERE paper_trade_id=ANY($1::bigint[]) ORDER BY paper_trade_id,at,id`, [tradeIds]) : [];
  const walletRows = contracts.length ? await query('wallet evidence',
    `SELECT h.ca,h.wallet,h.at,h.buy_at,h.buy_price,w.type,w.quality_verdict,w.win_rate,w.round_trips,
            w.winners_hit,w.discovered_from,w.last_active
       FROM wallet_hits h LEFT JOIN smart_wallets w ON w.wallet=h.wallet
      WHERE h.ca=ANY($1::text[]) ORDER BY h.ca,h.buy_at`, [contracts]) : [];
  const aiRows = contracts.length ? await query('AI conviction evidence',
    `SELECT ca,symbol,verdict,delta,reason,at FROM ai_conviction WHERE ca=ANY($1::text[])`, [contracts]) : [];

  const snapshotsByTrade = groupBy(snapshots, row => String((row as any).paper_trade_id));
  const eventsByTrade = groupBy(events, row => String((row as any).paper_trade_id));
  const walletsByContract = groupBy(walletRows, row => String((row as any).ca));
  const aiByContract = new Map(aiRows.map(row => [String(row.ca), row]));
  const dailyConfigSnapshotsById: Record<string, unknown> = {};
  const tradeLedger = trades.map(row => {
    const id = configSnapshotId(row.config_snapshot);
    if (id && !dailyConfigSnapshotsById[id]) dailyConfigSnapshotsById[id] = row.config_snapshot;
    return normalizeTrade(
      row,
      snapshotsByTrade[String(row.id)] || [],
      eventsByTrade[String(row.id)] || [],
      walletsByContract[String(row.ca)] || [],
      aiByContract.get(String(row.ca)) || null,
      id,
    );
  });

  const [dailySummaryRows, overallRows, performanceBySetup, performanceBySource, performanceBySignal,
    dataQualityRows, filterTuning, weightTuning, modelSuggestions, aiReviews, missedRows] = await Promise.all([
    query('daily trade summary', `SELECT
      COUNT(*) FILTER (WHERE entry_at>now()-($1||' days')::interval)::int AS opened,
      COUNT(*) FILTER (WHERE entry_at>now()-($1||' days')::interval AND strategy_role='timed_entry')::int AS timed_entries_opened,
      COUNT(*) FILTER (WHERE entry_at>now()-($1||' days')::interval AND strategy_role IS DISTINCT FROM 'timed_entry')::int AS research_observations_opened,
      COUNT(*) FILTER (WHERE exit_at>now()-($1||' days')::interval)::int AS closed,
      COUNT(*) FILTER (WHERE NOT closed)::int AS currently_open,
      COUNT(*) FILTER (WHERE exit_at>now()-($1||' days')::interval AND exit_reason='tracking_lost')::int AS tracking_lost,
      COUNT(*) FILTER (WHERE entry_at>now()-($1||' days')::interval AND execution_eligible)::int AS executable_opened,
      COUNT(*) FILTER (WHERE exit_at>now()-($1||' days')::interval AND final_multiple>=3)::int AS closed_at_or_above_3x,
      -- HONEST ACCOUNTING: money-shaped fields cover strategy_role='timed_entry' ONLY.
      -- Research observations carry $0 notional; summing their unbounded mark-to-final
      -- marks produced fantasy headline P&L (+$51k/day from unexited 1000x observation
      -- marks) that the strategyLifecycle section itself disclaimed.
      ROUND((AVG(final_multiple) FILTER (WHERE strategy_role='timed_entry' AND exit_at>now()-($1||' days')::interval AND exit_reason IS DISTINCT FROM 'tracking_lost'))::numeric,3) AS avg_final_multiple,
      ROUND((SUM(pnl_pct) FILTER (WHERE strategy_role='timed_entry' AND exit_at>now()-($1||' days')::interval AND exit_reason IS DISTINCT FROM 'tracking_lost'))::numeric,2) AS normalized_pnl_usd_on_100_each
      FROM paper_trades`, [windowParameter]),
    query('overall trade summary', `SELECT COUNT(*)::int AS total_calls,
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
      ROUND((AVG(final_multiple) FILTER (WHERE closed AND exit_reason IS DISTINCT FROM 'tracking_lost'))::numeric,3) AS research_avg_final_multiple,
      ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY final_multiple)
        FILTER (WHERE closed AND exit_reason IS DISTINCT FROM 'tracking_lost'))::numeric,3) AS research_median_final_multiple,
      COUNT(*) FILTER (WHERE strategy_role='timed_entry')::int AS timed_entry_calls,
      -- HONEST ACCOUNTING: only timed entries have notional; see daily summary note.
      ROUND((AVG(final_multiple) FILTER (WHERE strategy_role='timed_entry' AND closed AND exit_reason IS DISTINCT FROM 'tracking_lost'))::numeric,3) AS avg_final_multiple,
      ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY final_multiple)
        FILTER (WHERE strategy_role='timed_entry' AND closed AND exit_reason IS DISTINCT FROM 'tracking_lost'))::numeric,3) AS median_final_multiple,
      ROUND((AVG(pnl_pct) FILTER (WHERE strategy_role='timed_entry' AND closed AND exit_reason IS DISTINCT FROM 'tracking_lost'))::numeric,2) AS avg_pnl_pct,
      ROUND((SUM(pnl_pct) FILTER (WHERE strategy_role='timed_entry' AND closed AND exit_reason IS DISTINCT FROM 'tracking_lost'))::numeric,2) AS normalized_pnl_usd_on_100_each
      FROM paper_trades`),
    query('performance by setup', `WITH calls AS (
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
      FROM calls GROUP BY 1 ORDER BY calls DESC`),
    query('performance by source', `SELECT COALESCE(t.source,'unknown') AS source,
      COUNT(*)::int AS calls,COUNT(*) FILTER (WHERE p.execution_eligible)::int AS executable,
      COUNT(*) FILTER (WHERE p.closed AND p.exit_reason IS DISTINCT FROM 'tracking_lost')::int AS resolved,
      COUNT(*) FILTER (WHERE p.closed AND p.exit_reason IS DISTINCT FROM 'tracking_lost' AND p.final_multiple>=3)::int AS reached_3x,
      ROUND((AVG(p.final_multiple) FILTER (WHERE p.closed AND p.exit_reason IS DISTINCT FROM 'tracking_lost'))::numeric,3) AS avg_final_multiple,
      ROUND((SUM(p.pnl_pct) FILTER (WHERE p.closed AND p.exit_reason IS DISTINCT FROM 'tracking_lost'))::numeric,2) AS normalized_pnl_usd_on_100_each
      FROM paper_trades p LEFT JOIN tokens t ON t.ca=p.ca GROUP BY 1 ORDER BY calls DESC`),
    query('performance by signal', `SELECT signal,model_version,COUNT(*)::int AS calls,
      COUNT(*) FILTER (WHERE execution_eligible)::int AS executable,
      COUNT(*) FILTER (WHERE closed AND exit_reason IS DISTINCT FROM 'tracking_lost')::int AS resolved,
      COUNT(*) FILTER (WHERE closed AND exit_reason IS DISTINCT FROM 'tracking_lost' AND final_multiple>=3)::int AS reached_3x,
      ROUND((AVG(final_multiple) FILTER (WHERE closed AND exit_reason IS DISTINCT FROM 'tracking_lost'))::numeric,3) AS avg_final_multiple,
      ROUND((SUM(pnl_pct) FILTER (WHERE closed AND exit_reason IS DISTINCT FROM 'tracking_lost'))::numeric,2) AS normalized_pnl_usd_on_100_each
      FROM paper_trades GROUP BY signal,model_version ORDER BY calls DESC`),
    query('overall evidence completeness', `SELECT COUNT(*)::int AS calls,
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
      FROM paper_trades`),
    query('filter tuning log', `SELECT * FROM filter_tuning_log WHERE at>now()-($1||' days')::interval ORDER BY at DESC LIMIT 300`, [windowParameter]),
    query('weight tuning log', `SELECT * FROM weight_tuning_log WHERE at>now()-($1||' days')::interval ORDER BY at DESC LIMIT 300`, [windowParameter]),
    query('model suggestions', `SELECT * FROM model_suggestions WHERE created_at>now()-($1||' days')::interval ORDER BY created_at DESC LIMIT 300`, [windowParameter]),
    query('AI review history', `SELECT at,review FROM ai_reviews WHERE at>now()-($1||' days')::interval ORDER BY at DESC LIMIT 100`, [windowParameter]),
    query('database-only missed opportunities', `SELECT t.ca,t.symbol,t.source,t.first_seen,t.gate_result,t.gate_fail_reason,
      t.last_score,ROUND(MAX(o.multiple_from_first)::numeric,2) AS best_multiple
      FROM tokens t JOIN outcomes o ON o.ca=t.ca
      WHERE t.first_seen>now()-interval '48 hours' AND o.multiple_from_first IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM paper_trades p WHERE p.ca=t.ca)
      GROUP BY t.ca,t.symbol,t.source,t.first_seen,t.gate_result,t.gate_fail_reason,t.last_score
      HAVING MAX(o.multiple_from_first)>=3 ORDER BY MAX(o.multiple_from_first) DESC LIMIT 50`),
  ]);

  const missedOpportunities = {
    scope: 'database-only; no live external network sweep is run inside the report request',
    count: missedRows.length,
    rows: missedRows,
  };

  // 3X AUTOPSY, rebuilt (review findings 5-9). Separate questions get separate
  // baselines: quality observations reaching 3x from the QUALITY price, timed
  // entries reaching 3x from their OWN entry price, and capture measured by the
  // explicit target fields (verified = execution-proven target_hit_at, observed =
  // mark-based). Block reasons are the last rejection BEFORE the quality peak, so
  // a rejection that postdates the move can never masquerade as the cause.
  // Aggregates are computed unlimited; only the display rows are capped.
  const qualityThreeX = await query('three_x_quality', `
    SELECT DISTINCT ON (p.ca) p.ca, p.symbol,
           ROUND((p.peak_price/NULLIF(p.entry_price,0))::numeric,2) AS quality_peak_multiple,
           p.peak_at AS quality_peak_at
      FROM paper_trades p
     WHERE p.entry_at > now()-($1||' days')::interval
       AND p.strategy_role='quality_observation' AND p.signal IS DISTINCT FROM 'post_exit_watch'
       AND p.entry_price>0 AND p.peak_price >= 3*p.entry_price
     ORDER BY p.ca, (p.peak_price/NULLIF(p.entry_price,0)) DESC`, [windowParameter]);
  const timedThreeX = await query('three_x_timed', `
    SELECT p.ca,
           ROUND(MAX(p.peak_price/NULLIF(p.entry_price,0))::numeric,2) AS timed_peak_multiple,
           BOOL_OR(p.target_hit_at IS NOT NULL) AS captured_3x_verified,
           BOOL_OR(p.observed_target_hit_at IS NOT NULL) AS captured_3x_observed
      FROM paper_trades p
     WHERE p.entry_at > now()-($1||' days')::interval AND p.strategy_role='timed_entry'
       AND p.entry_price>0
     GROUP BY p.ca`, [windowParameter]);
  const blockedBeforePeak = await query('three_x_block_reasons', `
    WITH q AS (
      SELECT DISTINCT ON (p.ca) p.ca, p.peak_at
        FROM paper_trades p
       WHERE p.entry_at > now()-($1||' days')::interval
         AND p.strategy_role='quality_observation' AND p.signal IS DISTINCT FROM 'post_exit_watch'
         AND p.entry_price>0 AND p.peak_price >= 3*p.entry_price
       ORDER BY p.ca, (p.peak_price/NULLIF(p.entry_price,0)) DESC)
    SELECT q.ca, blocked.reason_code
      FROM q LEFT JOIN LATERAL (
        SELECT s.reason_code FROM signal_decisions s
         WHERE s.ca=q.ca AND s.allow=false AND s.evaluated_at <= q.peak_at
         ORDER BY s.evaluated_at DESC LIMIT 1) blocked ON true`, [windowParameter]);
  const shadowVerdict = await query('post_exit_shadow_verdict', `
    SELECT COUNT(*)::int AS shadows,
           COUNT(*) FILTER (WHERE s.peak_price >= 3*parent.entry_price)::int AS original_trade_reached_3x_after_exit,
           COUNT(*) FILTER (WHERE s.peak_price >= 1.5*parent.entry_price)::int AS original_reached_1_5x_after_exit,
           COUNT(*) FILTER (WHERE s.peak_price >= 3*s.entry_price)::int AS continued_3x_from_exit_price
      FROM paper_trades s JOIN paper_trades parent ON parent.id=s.parent_id
     WHERE s.signal='post_exit_watch' AND s.entry_at > now()-($1||' days')::interval`, [windowParameter]);

  // Layer beneath the watchlist (user request 2026-07-28): coins killed at the
  // GATE that still reached 3x from their kill-time snapshot — the misses that
  // never earned a paper row. Sourced from the outcomes snapshots the kill flow
  // already records; reasons come from the gate itself. Report-only.
  const killedThreeX = await query('three_x_gate_killed', `
    SELECT t.ca, MAX(t.symbol) AS symbol, MAX(t.gate_fail_reason) AS gate_fail_reason,
           ROUND(MAX(o.multiple_from_first)::numeric, 2) AS peak_multiple_from_kill
      FROM outcomes o JOIN tokens t ON t.ca=o.ca
     WHERE o.taken_at > now()-($1||' days')::interval
       AND t.gate_result='kill'
       AND NOT EXISTS (SELECT 1 FROM paper_trades p WHERE p.ca=t.ca)
     GROUP BY t.ca
    HAVING MAX(o.multiple_from_first) >= 3
     ORDER BY MAX(o.multiple_from_first) DESC
     LIMIT 500`, [windowParameter]);
  const killedByReason: Record<string, number> = {};
  for (const row of killedThreeX) {
    const key = String(row.gate_fail_reason || 'unknown_gate_reason');
    killedByReason[key] = (killedByReason[key] || 0) + 1;
  }

  // 3X OVERSHOOT (user request 2026-07-28): for every 3x exit we actually took,
  // the post-exit shadow measures how far the coin ran AFTER we sold everything.
  // Peak-based figures are an UPPER BOUND on what any runner policy could have
  // kept — the peak is not a realizable exit — and are labeled as such. This is
  // the evidence base for a future partial-exit/runner design; nothing here
  // changes the strategy.
  const overshootRows = await query('three_x_overshoot', `
    SELECT parent.ca, MAX(parent.symbol) AS symbol, MAX(parent.exit_reason) AS exit_reason,
           MAX(parent.exit_at) AS exit_at,
           ROUND(MAX(s.peak_price/NULLIF(parent.entry_price,0))::numeric, 2) AS post_exit_peak_vs_entry,
           ROUND(MAX(s.peak_price/NULLIF(s.entry_price,0))::numeric, 2) AS continuation_vs_exit,
           ROUND(MAX(EXTRACT(EPOCH FROM (s.peak_at - parent.exit_at))/60)::numeric, 1) AS minutes_to_post_exit_peak
      FROM paper_trades s JOIN paper_trades parent ON parent.id=s.parent_id
     WHERE s.signal='post_exit_watch'
       AND parent.exit_reason IN ('target_3x_exit_simulated','strategy_take_profit_3x','target_3x_observed_legacy')
       AND parent.entry_at > now()-($1||' days')::interval
     GROUP BY parent.ca
     ORDER BY MAX(s.peak_price/NULLIF(parent.entry_price,0)) DESC
     LIMIT 200`, [windowParameter]);
  const overshootMultiples = overshootRows.map((row: any) => Number(row.post_exit_peak_vs_entry)).filter((value: number) => Number.isFinite(value));
  const sortedOvershoot = [...overshootMultiples].sort((left, right) => left - right);
  const threeXOvershoot = {
    exitsTracked: overshootRows.length,
    medianPostExitPeakVsEntry: sortedOvershoot.length ? sortedOvershoot[Math.floor(sortedOvershoot.length / 2)] : null,
    maxPostExitPeakVsEntry: sortedOvershoot.length ? sortedOvershoot[sortedOvershoot.length - 1] : null,
    ranPast4x: overshootMultiples.filter((value: number) => value >= 4).length,
    ranPast5x: overshootMultiples.filter((value: number) => value >= 5).length,
    ranPast10x: overshootMultiples.filter((value: number) => value >= 10).length,
    leftOnTablePer100UpperBoundUsd: Number(overshootMultiples
      .reduce((sum: number, value: number) => sum + Math.max(0, (value - 3)) * 100, 0).toFixed(2)),
    rows: overshootRows.slice(0, 40),
    note: 'Upper-bound accounting: post-exit peaks are not realizable exits. leftOnTablePer100UpperBoundUsd sums (peak - 3x) x $100 across tracked 3x exits — the ceiling any runner-keeping policy could have captured, not an expectation. Evidence for future partial-exit design; no strategy behavior changes here.',
  };

  const timedByCa = new Map<string, any>(timedThreeX.map((row: any) => [String(row.ca), row]));
  const reasonByCa = new Map<string, string | null>(blockedBeforePeak.map((row: any) => [String(row.ca), row.reason_code || null]));
  const missedByReason: Record<string, number> = {};
  for (const row of qualityThreeX) {
    if (!timedByCa.has(String(row.ca))) {
      const key = String(reasonByCa.get(String(row.ca)) || 'no_block_recorded_before_peak');
      missedByReason[key] = (missedByReason[key] || 0) + 1;
    }
  }
  const threeXAutopsy = {
    observed3xFromQualityPrice: qualityThreeX.length,
    enteredAmongThem: qualityThreeX.filter((row: any) => timedByCa.has(String(row.ca))).length,
    timedEntriesReaching3xFromOwnEntry: timedThreeX.filter((row: any) => Number(row.timed_peak_multiple) >= 3).length,
    captured3xVerified: timedThreeX.filter((row: any) => row.captured_3x_verified).length,
    captured3xObserved: timedThreeX.filter((row: any) => row.captured_3x_observed).length,
    missedByReason,
    killedBeforeWatch: { count: killedThreeX.length, byGateReason: killedByReason, rows: killedThreeX.slice(0, 40) },
    threeXOvershoot,
    exitLadderVerdict: shadowVerdict[0] || { shadows: 0, original_trade_reached_3x_after_exit: 0, original_reached_1_5x_after_exit: 0, continued_3x_from_exit_price: 0 },
    rows: qualityThreeX.slice(0, 60).map((row: any) => ({
      ...row,
      had_timed_entry: timedByCa.has(String(row.ca)),
      timed_peak_multiple: timedByCa.get(String(row.ca))?.timed_peak_multiple ?? null,
      captured_3x_verified: !!timedByCa.get(String(row.ca))?.captured_3x_verified,
      last_block_reason_before_peak: reasonByCa.get(String(row.ca)) || null,
    })),
    note: 'Baselines are deliberately separate: observed3xFromQualityPrice measures 3x from the quality-observation price; timedEntriesReaching3xFromOwnEntry measures 3x from the actual timed-entry price; captured3xVerified means execution-proven. exitLadderVerdict compares shadow peaks against the PARENT entry (did the original trade later reach 3x) and the exit price (pure continuation). Known limitation: one shadow per token per model version, so a re-entered token second exit is not shadowed.',
  };

  return {
    reportType: 'all_time_master_review',
    generated,
    currentModelVersion: MODEL_VERSION,
    reportWindow: { days: boundedDays, description: 'Complete history: every trade, outcome, suggestion, and evidence aggregate the bot has ever recorded. Full per-trade telemetry covers the most recent 2 days; allTimeTradeLedger lists every trade ever in compact form.' },
    copyInstructions: 'Copy this entire JSON. It contains daily operating evidence, cumulative results, every trade, entry/exit rationale, execution evidence, and a compact decision-relevant market path.',
    windowTradeSummary: dailySummaryRows[0] || {},   // all-time window (mirrors overall.tradeSummary)
    overall: {
      tradeSummary: overallRows[0] || {},
      performanceBySetup,
      performanceBySource,
      performanceBySignal,
    },
    recentTradeLedgerFullDetail: tradeLedger,
    dailyConfigSnapshotsById,
    missedOpportunities,
    evidenceCompleteness: dataQualityRows[0] || {},
    runtimeHealth: {
      pumpfun: pumpfunStreamDiag(), aged: agedDiag(), momentum: momentumDiag(), social: socialDiag(),
      helius: heliusHealth(), walletDiscovery: discoveryDiag(), walletWebhook: webhookDiag(),
      winnerMiner: winnerMinerDiag(), paper: await paperDiag(), callTelemetry: await paperTelemetryDiag(),
    },
    changesDuringWindow: { filterTuning, weightTuning, modelSuggestions, aiReviews },
    configInForce: cfg(),
    threeXAutopsy,
    queryErrors: errors,
    payloadPolicy: {
      everyTradeIncluded: true,
      dailyMarketPath: 'one observation per minute for 0-10m, per 5m for 10-60m, per 15m for 1-4h, then hourly; lifecycle events remain complete',
      largeRawBlobsDuplicated: false,
      externalNetworkCallsDuringReport: false,
    },
    interpretationRules: [
      'recentTradeLedgerFullDetail carries complete telemetry for trades touching the last 2 days; allTimeTradeLedger lists every trade the bot has ever made in compact form; all aggregates span full history.',
      'Every historical trade is included in allTimeTradeLedger from the historical section.',
      'recordedReasons are extracted only from persisted signal, conviction, trigger, rank, and model evidence.',
      'tracking_lost rows are excluded from profitability calculations rather than silently counted as wins or losses.',
      'normalizedPnlUsdOn100 treats every resolved call as a hypothetical $100 position for comparability.',
      'No private key is required and no live transaction broadcasting is enabled by this review.',
    ],
  };
}
