import { pool } from '../db';
import { buildPrivateReadiness } from '../ops/private-readiness';
import { getToken } from '../store';
import { MODEL_VERSION } from '../model/version';
import { ExecutionEvidence } from '../types';
import { executionSettings, quoteExecutableEntry, quoteExecutableExit } from './execution';
import { quoteCategory, quotePhase } from './quote-status';
import {
  noteTrackingGraceDeferral,
  noteTrackingLostAfterGrace,
  recoverPaperMark,
  shouldDeclareTrackingLost,
  trackingRecoveryDiag,
} from './tracking-recovery';
import {
  finalizePaperTelemetry,
  PaperTelemetryContext,
  paperTelemetryDiag,
  recordPaperEvent,
  recordPaperOpened,
  recordPaperSnapshot,
} from './telemetry';

export type PaperSignal = 'trigger' | 'conviction' | 'bb_smart' | 'bb_organic' | 'bb_pregrad' | 'bb_secondwave'
  | 'model' | 'model_raw' | 'model_executable';

export interface OpenPaperOptions {
  skipExecutionQuote?: boolean;
  telemetry?: PaperTelemetryContext;
}

export async function openPaper(
  ca: string, symbol: string, signal: PaperSignal, markPrice: number, score: number | null,
  screenedExecution?: ExecutionEvidence,
  options: OpenPaperOptions = {},
) {
  if (!pool || !markPrice || markPrice <= 0) return;
  const keyPresent = !!process.env.JUPITER_API_KEY;
  const predicate = signal === 'model_raw' ? 'preliminary_pass=true' : 'allow=true';
  const decision = await pool.query(
    `SELECT id FROM signal_decisions WHERE ca=$1 AND model_version=$2 AND ${predicate}
      ORDER BY evaluated_at DESC LIMIT 1`,
    [ca, MODEL_VERSION],
  ).catch(() => ({ rows: [] as any[] }));
  const decisionId = decision.rows[0]?.id || null;
  const initialQuoteStatus = options.skipExecutionQuote ? 'shadow_raw_no_execution' : 'quote_pending';
  const inserted = await pool.query(
    `INSERT INTO paper_trades
       (ca,symbol,signal,entry_price,mark_entry_price,entry_score,peak_price,peak_at,last_price,last_at,
        target_multiple,quote_status,model_version,quote_key_present,signal_decision_id,
        transaction_built,simulation_ok,simulation_error,route_stability_bps,execution_score,execution_probe,
        trough_price,trough_at,max_runup_pct,max_drawdown_pct)
     VALUES ($1,$2,$3,$4,$4,$5,$4,now(),$4,now(),$6,$16,$7,$8,$9,$10,$11,$12,$13,$14,$15,$4,now(),0,0)
     ON CONFLICT (ca,signal,model_version) DO NOTHING RETURNING id`,
    [ca, symbol, signal, markPrice, score, executionSettings.targetMultiple, MODEL_VERSION, keyPresent,
     decisionId, screenedExecution?.transactionBuilt || false, screenedExecution?.simulationOk || false,
     screenedExecution?.simulationError || null, screenedExecution?.routeStabilityBps || null,
     screenedExecution?.executionScore || null, screenedExecution ? JSON.stringify(screenedExecution) : null,
     initialQuoteStatus],
  ).catch((error: Error) => { console.error('[paper] insert failed:', error.message); return null; });
  if (!inserted?.rowCount) return;

  const paperTradeId = Number(inserted.rows[0].id);
  const token = getToken(ca);
  if (token) {
    await recordPaperOpened(paperTradeId, token, signal, markPrice, options.telemetry || {});
  }

  if (options.skipExecutionQuote) {
    await pool.query(
      `UPDATE paper_trades SET quote_attempted_at=now(),quote_key_present=$4
        WHERE ca=$1 AND signal=$2 AND model_version=$3`, [ca, signal, MODEL_VERSION, keyPresent],
    ).catch(() => {});
    await recordPaperEvent(paperTradeId, token || null, signal, MODEL_VERSION,
      'entry_quote_skipped', 'entry_quote', markPrice, 'shadow observation does not request execution',
      { status: 'shadow_raw_no_execution', keyPresent }, Date.now());
    return;
  }

  if (!token) {
    await pool.query(
      `UPDATE paper_trades SET quote_status='token_not_in_memory',quote_attempted_at=now(),quote_key_present=$4
        WHERE ca=$1 AND signal=$2 AND model_version=$3`, [ca, signal, MODEL_VERSION, keyPresent],
    ).catch(() => {});
    await recordPaperEvent(paperTradeId, null, signal, MODEL_VERSION,
      'entry_quote_failed', 'entry_quote', markPrice, 'token_not_in_memory', { keyPresent }, Date.now());
    return;
  }

  const quote = await quoteExecutableEntry(token, markPrice);
  await pool.query(
    `UPDATE paper_trades SET
       entry_price=CASE WHEN $4 THEN $5 ELSE entry_price END,execution_eligible=$4,quote_status=$6,
       quote_attempted_at=now(),quote_key_present=$16,position_sol=$7,position_usd=$8,quoted_out_usd=$9,
       quoted_out_amount=$10,price_impact_pct=$11,slippage_bps=$12,fee_lamports=$13,router=$14,quote_time_ms=$15,
       transaction_built=$17,simulation_ok=$18,simulation_error=$19,simulation_units=$20,
       route_stability_bps=$21,execution_score=$22,execution_probe=$23
     WHERE ca=$1 AND signal=$2 AND model_version=$3`,
    [ca, signal, MODEL_VERSION, quote.eligible, quote.effectiveEntryPrice, quote.status,
     quote.positionSol, quote.positionUsd, quote.quotedOutUsd, quote.quotedOutAmount,
     quote.priceImpact, quote.slippageBps, quote.feeLamports, quote.router, quote.quoteTimeMs,
     keyPresent, quote.transactionBuilt, quote.simulationOk, quote.simulationError, quote.unitsConsumed,
     quote.routeStabilityBps, quote.executionScore, JSON.stringify(quote.probeSizes)],
  ).catch(error => console.error('[paper] entry persist', error.message));
  await recordPaperEvent(paperTradeId, token, signal, MODEL_VERSION,
    quote.eligible ? 'entry_quote_eligible' : 'entry_quote_ineligible', 'entry_quote',
    quote.effectiveEntryPrice || markPrice, quote.status, quote, Date.now());
}

export function startPaperTrader() {
  if (!pool) return;
  const timer = setInterval(() => mark().catch(error => console.error('[paper]', error.message)), 15_000);
  timer.unref();
}

const trackingRecoveryNoted = new Set<number>();

async function mark() {
  if (!pool) return;
  const open = await pool.query(
    `SELECT id,ca,signal,model_version,entry_price,entry_at,last_at,peak_price,trough_price,target_hit_at,observed_target_hit_at,
            execution_eligible,position_usd,quoted_out_amount,exit_quote_status
       FROM paper_trades WHERE closed=false`,
  ).catch(() => ({ rows: [] as any[] }));
  for (const row of open.rows) {
    const token = getToken(row.ca);
    let price = token && token.priceUsd > 0 ? token.priceUsd : 0;
    let recovered = false;

    if (!(price > 0)) {
      const fallback = await recoverPaperMark(row.ca);
      if (!fallback) {
        if (shouldDeclareTrackingLost(row.last_at || row.entry_at)) {
          noteTrackingLostAfterGrace();
          await closeAt(row, token || null, null, 'tracking_lost');
        } else {
          noteTrackingGraceDeferral();
        }
        continue;
      }
      price = fallback.price;
      recovered = true;
      const paperId = Number(row.id);
      if (!trackingRecoveryNoted.has(paperId)) {
        trackingRecoveryNoted.add(paperId);
        await recordPaperEvent(paperId, token || null, row.signal, row.model_version,
          'tracking_recovered', 'tracking_recovered_dexscreener', price,
          'in-memory token mark unavailable; Dexscreener fallback restored outcome tracking', fallback, Date.now());
      }
    }

    const entry = Number(row.entry_price);
    if (!Number.isFinite(entry) || entry <= 0) continue;
    const previousPeak = Number(row.peak_price) || entry;
    const previousTrough = Number(row.trough_price) || entry;
    const peak = Math.max(previousPeak, price);
    const trough = Math.min(previousTrough, price);
    const multiple = price / entry;
    const peakMultiple = peak / entry;
    const troughMultiple = trough / entry;
    const ageHours = (Date.now() - new Date(row.entry_at).getTime()) / 3_600_000;
    const observedTarget = peakMultiple >= executionSettings.targetMultiple;

    if (token) await recordPaperSnapshot(row, token);
    await pool.query(
      `UPDATE paper_trades SET last_price=$2,last_at=now(),peak_price=$3,
         peak_at=CASE WHEN $3>peak_price THEN now() ELSE peak_at END,
         trough_price=CASE WHEN trough_price IS NULL OR $4<trough_price THEN $4 ELSE trough_price END,
         trough_at=CASE WHEN trough_price IS NULL OR $4<trough_price THEN now() ELSE trough_at END,
         max_runup_pct=GREATEST(COALESCE(max_runup_pct,0),$5),
         max_drawdown_pct=LEAST(COALESCE(max_drawdown_pct,0),$6),
         observed_target_hit_at=CASE WHEN observed_target_hit_at IS NULL AND $7 THEN now() ELSE observed_target_hit_at END
       WHERE id=$1 AND closed=false`,
      [row.id, price, peak, trough, (peakMultiple - 1) * 100, (troughMultiple - 1) * 100, observedTarget],
    ).catch(() => {});

    if (observedTarget && !row.observed_target_hit_at) {
      await recordPaperEvent(row.id, token || null, row.signal, row.model_version,
        'observed_target_reached', 'observed_target', peak, null,
        { targetMultiple: executionSettings.targetMultiple, peakMultiple, markSource: recovered ? 'dexscreener_recovery' : 'memory' }, Date.now());
    }

    let verified = false;
    let verifiedExitPrice: number | null = null;
    if (observedTarget && !row.target_hit_at) {
      if (!row.execution_eligible && row.model_version === 'legacy') {
        verified = true;
        verifiedExitPrice = entry * executionSettings.targetMultiple;
      } else if (row.execution_eligible && row.quoted_out_amount && Number(row.position_usd) > 0) {
        const exit = await quoteExecutableExit(row.ca, String(row.quoted_out_amount));
        const realized = exit.eligible && exit.proceedsUsd ? exit.proceedsUsd / Number(row.position_usd) : 0;
        await pool.query(
          `UPDATE paper_trades SET exit_quote_status=$2,exit_quoted_usd=$3,exit_price_impact_pct=$4,
             exit_fee_lamports=$5,exit_router=$6,exit_quote_time_ms=$7,exit_transaction_built=$8,
             exit_simulation_ok=$9,exit_simulation_error=$10
           WHERE id=$1`,
          [row.id, exit.status, exit.proceedsUsd, exit.priceImpact,
           exit.feeLamports, exit.router, exit.quoteTimeMs, exit.transactionBuilt, exit.simulationOk, exit.simulationError],
        ).catch(() => {});
        await recordPaperEvent(row.id, token || null, row.signal, row.model_version,
          exit.eligible ? 'exit_quote_eligible' : 'exit_quote_ineligible', 'target_exit_quote',
          price, exit.status, { ...exit, realizedMultiple: realized }, Date.now());
        if (exit.eligible && realized >= executionSettings.targetMultiple) {
          verified = true;
          verifiedExitPrice = entry * realized;
        }
      }
    }
    if (verified) {
      await pool.query(
        `UPDATE paper_trades SET target_hit_at=COALESCE(target_hit_at,now()),
           seconds_to_target=COALESCE(seconds_to_target,EXTRACT(EPOCH FROM (now()-entry_at))::int)
         WHERE id=$1`, [row.id],
      ).catch(() => {});
      await recordPaperEvent(row.id, token || null, row.signal, row.model_version,
        'verified_target_reached', 'verified_target', verifiedExitPrice,
        row.execution_eligible ? 'target exit simulated' : 'legacy observed target',
        { targetMultiple: executionSettings.targetMultiple }, Date.now());
      await closeAt(row, token || null, verifiedExitPrice,
        row.execution_eligible ? 'target_3x_exit_simulated' : 'target_3x_observed_legacy');
      continue;
    }
    if (observedTarget && row.signal === 'model_raw') {
      await closeAt(row, token || null, price, 'target_3x_observed_shadow');
      continue;
    }
    let reason: string | null = null;
    if (multiple <= executionSettings.stopMultiple) reason = `stop_${Math.round((1 - executionSettings.stopMultiple) * 100)}pct`;
    else if (token?.state === 'DEAD') reason = 'coin_died';
    else if (ageHours >= executionSettings.maxHoldHours) reason = `time_${executionSettings.maxHoldHours}h`;
    if (reason) await closeAt(row, token || null, price, reason);
  }
}

async function closeAt(row: any, token: ReturnType<typeof getToken> | null, price: number | null, reason: string) {
  if (!pool) return;
  const closed = await pool.query(
    `UPDATE paper_trades SET closed=true,exit_at=now(),exit_reason=$2,
       exit_price=COALESCE($3,last_price,entry_price)
     WHERE id=$1 AND closed=false RETURNING id`,
    [row.id, reason, price],
  ).catch(() => null);
  if (!closed?.rowCount) return;
  trackingRecoveryNoted.delete(Number(row.id));
  await finalizePaperTelemetry(Number(row.id), token || null, price, reason);
}

const numberValue = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : 0;

export async function paperScoreboard(days = 30): Promise<any[]> {
  if (!pool) return [];
  const result = await pool.query(
    `SELECT signal,model_version,COUNT(*) AS observations,
       COUNT(*) FILTER (WHERE closed AND exit_reason IS DISTINCT FROM 'tracking_lost') AS resolved_observed,
       COUNT(*) FILTER (WHERE execution_eligible) AS executable,
       COUNT(*) FILTER (WHERE transaction_built) AS transaction_built,
       COUNT(*) FILTER (WHERE simulation_ok) AS simulation_ok,
       COUNT(*) FILTER (WHERE execution_eligible AND closed AND exit_reason IS DISTINCT FROM 'tracking_lost') AS resolved_executable,
       COUNT(*) FILTER (WHERE NOT execution_eligible) AS quote_ineligible,
       COUNT(*) FILTER (WHERE exit_reason='tracking_lost') AS incomplete,
       COUNT(*) FILTER (WHERE observed_target_hit_at IS NOT NULL) AS observed_hits_3x,
       COUNT(*) FILTER (WHERE execution_eligible AND target_hit_at IS NOT NULL) AS hits_3x,
       ROUND(AVG(COALESCE(exit_price,last_price)/NULLIF(entry_price,0)) FILTER
         (WHERE closed AND exit_reason IS DISTINCT FROM 'tracking_lost')::numeric,3) AS avg_observed_return,
       ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY COALESCE(exit_price,last_price)/NULLIF(entry_price,0))
         FILTER (WHERE closed AND exit_reason IS DISTINCT FROM 'tracking_lost'))::numeric,3) AS median_observed_return,
       ROUND((COUNT(*) FILTER (WHERE observed_target_hit_at IS NOT NULL))::numeric/
         NULLIF(COUNT(*) FILTER (WHERE closed AND exit_reason IS DISTINCT FROM 'tracking_lost'),0)*100,1) AS pct_3x_observed,
       ROUND((COUNT(*) FILTER (WHERE closed AND exit_reason IS DISTINCT FROM 'tracking_lost'
         AND COALESCE(exit_price,last_price)/NULLIF(entry_price,0)<=0.5))::numeric/
         NULLIF(COUNT(*) FILTER (WHERE closed AND exit_reason IS DISTINCT FROM 'tracking_lost'),0)*100,1) AS severe_loss_pct_observed,
       ROUND(AVG(COALESCE(exit_price,last_price)/NULLIF(entry_price,0)) FILTER
         (WHERE execution_eligible AND closed AND exit_reason IS DISTINCT FROM 'tracking_lost')::numeric,3) AS avg_executable_return,
       ROUND((COUNT(*) FILTER (WHERE execution_eligible AND target_hit_at IS NOT NULL))::numeric/
         NULLIF(COUNT(*) FILTER (WHERE execution_eligible AND closed AND exit_reason IS DISTINCT FROM 'tracking_lost'),0)*100,1) AS pct_3x_executable,
       ROUND(MAX(peak_price/NULLIF(entry_price,0)) FILTER (WHERE execution_eligible)::numeric,2) AS best_observed_from_executable_entry,
       ROUND(AVG(seconds_to_target) FILTER (WHERE execution_eligible AND seconds_to_target IS NOT NULL)/60.0,1) AS avg_minutes_to_3x,
       PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY seconds_to_target) FILTER
         (WHERE execution_eligible AND seconds_to_target IS NOT NULL)/60.0 AS median_minutes_to_3x,
       ROUND(AVG(price_impact_pct) FILTER (WHERE execution_eligible)::numeric,4) AS avg_entry_price_impact,
       ROUND(AVG(exit_price_impact_pct) FILTER (WHERE target_hit_at IS NOT NULL AND execution_eligible)::numeric,4) AS avg_exit_price_impact,
       ROUND(AVG(execution_score)::numeric,3) AS avg_execution_score,
       ROUND(AVG(route_stability_bps)::numeric,1) AS avg_route_stability_bps,
       ROUND(AVG(quote_time_ms) FILTER (WHERE quote_time_ms IS NOT NULL)::numeric,0) AS avg_quote_ms,
       ROUND(AVG(max_runup_pct)::numeric,2) AS avg_max_runup_pct,
       ROUND(AVG(max_drawdown_pct)::numeric,2) AS avg_max_drawdown_pct,
       ROUND(AVG(duration_seconds)::numeric,0) AS avg_duration_seconds,
       COALESCE(SUM(snapshot_count),0)::bigint AS telemetry_snapshots,
       COALESCE(SUM(event_count),0)::bigint AS telemetry_events
     FROM paper_trades WHERE entry_at>now()-($1||' days')::interval
     GROUP BY signal,model_version ORDER BY model_version DESC,pct_3x_executable DESC NULLS LAST`, [String(days)],
  ).catch(() => null);
  return (result?.rows || []).map((row: any) => {
    const resolvedExecutable = numberValue(row.resolved_executable);
    const resolvedObserved = numberValue(row.resolved_observed);
    const isRaw = row.signal === 'model_raw';
    const resolved = isRaw ? resolvedObserved : resolvedExecutable;
    return { ...row, current_model: row.model_version === MODEL_VERSION,
      forward_ready: resolved >= executionSettings.minForwardSamples,
      evidence_status: resolved >= executionSettings.minForwardSamples
        ? `evidence-ready (${resolved} resolved ${isRaw ? 'observed' : 'simulated'} calls)`
        : `collecting (${resolved}/${executionSettings.minForwardSamples} resolved ${isRaw ? 'observed' : 'simulated'} calls)` };
  });
}

export async function paperQuoteStatusBreakdown(days = 30): Promise<any[]> {
  if (!pool) return [];
  const result = await pool.query(
    `SELECT model_version,quote_status,quote_key_present,transaction_built,simulation_ok,COUNT(*)::int AS n,
            MIN(entry_at) AS first_at,MAX(entry_at) AS last_at
       FROM paper_trades WHERE entry_at>now()-($1||' days')::interval
       GROUP BY model_version,quote_status,quote_key_present,transaction_built,simulation_ok
       ORDER BY model_version DESC,n DESC`, [String(days)],
  ).catch(() => ({ rows: [] as any[] }));
  return result.rows.map((row: any) => ({ ...row, phase: quotePhase(row.quote_status, row.quote_key_present),
    category: quoteCategory(row.quote_status), current_model: row.model_version === MODEL_VERSION }));
}

export async function paperDiag() {
  if (!pool) {
    const base = {
      db: false,
      open: 0,
      total: 0,
      executable: 0,
      transactionBuilt: 0,
      simulationOk: 0,
      hit3x: 0,
      quotePending: 0,
      quoteStatuses: [] as any[],
      recentClosed: 0,
      recentTrackingLost: 0,
      recentTrackingLostPct: null as number | null,
      executionEpochAt: null as string | null,
      trackingRecovery: trackingRecoveryDiag(),
      telemetry: await paperTelemetryDiag(),
    };
    return { ...base, privateReadiness: buildPrivateReadiness(base) };
  }
  const result = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE NOT closed) AS open,COUNT(*) AS total,
       COUNT(*) FILTER (WHERE execution_eligible) AS executable,COUNT(*) FILTER (WHERE transaction_built) AS transaction_built,
       COUNT(*) FILTER (WHERE simulation_ok) AS simulation_ok,COUNT(*) FILTER (WHERE observed_target_hit_at IS NOT NULL) AS observed_hit3x,
       COUNT(*) FILTER (WHERE execution_eligible AND target_hit_at IS NOT NULL) AS hit3x,
       COUNT(*) FILTER (WHERE quote_status='quote_pending') AS quote_pending,
       COUNT(*) FILTER (WHERE quote_status='jupiter_api_key_missing') AS missing_api_key,
       COUNT(*) FILTER (WHERE execution_eligible AND observed_target_hit_at IS NOT NULL AND target_hit_at IS NULL) AS exit_unverified,
       COUNT(*) FILTER (WHERE exit_at>now()-interval '24 hours') AS recent_closed,
       COUNT(*) FILTER (WHERE exit_at>now()-interval '24 hours' AND exit_reason='tracking_lost') AS recent_tracking_lost,
       MIN(entry_at) FILTER (WHERE model_version=$1 AND simulation_ok) AS execution_epoch_at
     FROM paper_trades`, [MODEL_VERSION],
  ).catch(() => ({ rows: [{}] }));
  const row = result.rows[0] || {};
  const recentClosed = numberValue(row.recent_closed);
  const recentTrackingLost = numberValue(row.recent_tracking_lost);
  const recentTrackingLostPct = recentClosed ? Math.round(recentTrackingLost / recentClosed * 1000) / 10 : null;
  const base = {
    db: true,
    open: numberValue(row.open), total: numberValue(row.total), executable: numberValue(row.executable),
    transactionBuilt: numberValue(row.transaction_built), simulationOk: numberValue(row.simulation_ok),
    observedHit3x: numberValue(row.observed_hit3x), hit3x: numberValue(row.hit3x),
    quotePending: numberValue(row.quote_pending), missingApiKey: numberValue(row.missing_api_key),
    exitUnverified: numberValue(row.exit_unverified), targetMultiple: executionSettings.targetMultiple,
    minForwardSamples: executionSettings.minForwardSamples, currentModel: MODEL_VERSION,
    recentClosed,
    recentTrackingLost,
    recentTrackingLostPct,
    executionEpochAt: row.execution_epoch_at ? new Date(row.execution_epoch_at).toISOString() : null,
    quoteStatuses: await paperQuoteStatusBreakdown(30),
    trackingRecovery: trackingRecoveryDiag(),
    telemetry: await paperTelemetryDiag(),
  };
  return { ...base, privateReadiness: buildPrivateReadiness(base) };
}
