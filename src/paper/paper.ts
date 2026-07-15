import { pool } from '../db';
import { getToken } from '../store';
import { MODEL_VERSION } from '../model/version';
import { ExecutionEvidence } from '../types';
import { executionSettings, quoteExecutableEntry, quoteExecutableExit } from './execution';
import { quoteCategory, quotePhase } from './quote-status';

export type PaperSignal = 'trigger' | 'conviction' | 'bb_smart' | 'bb_organic' | 'bb_pregrad' | 'bb_secondwave'
  | 'model' | 'model_raw' | 'model_executable';

export interface OpenPaperOptions {
  skipExecutionQuote?: boolean;
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
        transaction_built,simulation_ok,simulation_error,route_stability_bps,execution_score,execution_probe)
     VALUES ($1,$2,$3,$4,$4,$5,$4,now(),$4,now(),$6,$16,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT (ca,signal,model_version) DO NOTHING RETURNING id`,
    [ca, symbol, signal, markPrice, score, executionSettings.targetMultiple, MODEL_VERSION, keyPresent,
     decisionId, screenedExecution?.transactionBuilt || false, screenedExecution?.simulationOk || false,
     screenedExecution?.simulationError || null, screenedExecution?.routeStabilityBps || null,
     screenedExecution?.executionScore || null, screenedExecution ? JSON.stringify(screenedExecution) : null,
     initialQuoteStatus],
  ).catch((e: Error) => { console.error('[paper] insert failed:', e.message); return null; });
  if (!inserted?.rowCount) return;

  if (options.skipExecutionQuote) {
    await pool.query(
      `UPDATE paper_trades SET quote_attempted_at=now(),quote_key_present=$4
        WHERE ca=$1 AND signal=$2 AND model_version=$3`, [ca, signal, MODEL_VERSION, keyPresent],
    ).catch(() => {});
    return;
  }

  const token = getToken(ca);
  if (!token) {
    await pool.query(
      `UPDATE paper_trades SET quote_status='token_not_in_memory',quote_attempted_at=now(),quote_key_present=$4
        WHERE ca=$1 AND signal=$2 AND model_version=$3`, [ca, signal, MODEL_VERSION, keyPresent],
    ).catch(() => {});
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
}

export function startPaperTrader() {
  if (!pool) return;
  const timer = setInterval(() => mark().catch(error => console.error('[paper]', error.message)), 15_000);
  timer.unref();
}

async function mark() {
  if (!pool) return;
  const open = await pool.query(
    `SELECT ca,signal,model_version,entry_price,entry_at,peak_price,target_hit_at,observed_target_hit_at,
            execution_eligible,position_usd,quoted_out_amount,exit_quote_status
       FROM paper_trades WHERE closed=false`,
  ).catch(() => ({ rows: [] as any[] }));
  for (const row of open.rows) {
    const token = getToken(row.ca);
    if (!token || !token.priceUsd || token.priceUsd <= 0) {
      if (!token) await closeAt(row.ca, row.signal, row.model_version, null, 'tracking_lost');
      continue;
    }
    const entry = Number(row.entry_price);
    if (!Number.isFinite(entry) || entry <= 0) continue;
    const price = token.priceUsd;
    const previousPeak = Number(row.peak_price) || entry;
    const peak = Math.max(previousPeak, price);
    const multiple = price / entry;
    const peakMultiple = peak / entry;
    const ageHours = (Date.now() - new Date(row.entry_at).getTime()) / 3_600_000;
    const observedTarget = peakMultiple >= executionSettings.targetMultiple;
    await pool.query(
      `UPDATE paper_trades SET last_price=$4,last_at=now(),peak_price=$5,
         peak_at=CASE WHEN $5>peak_price THEN now() ELSE peak_at END,
         observed_target_hit_at=CASE WHEN observed_target_hit_at IS NULL AND $6 THEN now() ELSE observed_target_hit_at END
       WHERE ca=$1 AND signal=$2 AND model_version=$3 AND closed=false`,
      [row.ca, row.signal, row.model_version, price, peak, observedTarget],
    ).catch(() => {});

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
          `UPDATE paper_trades SET exit_quote_status=$4,exit_quoted_usd=$5,exit_price_impact_pct=$6,
             exit_fee_lamports=$7,exit_router=$8,exit_quote_time_ms=$9,exit_transaction_built=$10,
             exit_simulation_ok=$11,exit_simulation_error=$12
           WHERE ca=$1 AND signal=$2 AND model_version=$3`,
          [row.ca, row.signal, row.model_version, exit.status, exit.proceedsUsd, exit.priceImpact,
           exit.feeLamports, exit.router, exit.quoteTimeMs, exit.transactionBuilt, exit.simulationOk, exit.simulationError],
        ).catch(() => {});
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
         WHERE ca=$1 AND signal=$2 AND model_version=$3`, [row.ca, row.signal, row.model_version],
      ).catch(() => {});
      await closeAt(row.ca, row.signal, row.model_version, verifiedExitPrice,
        row.execution_eligible ? 'target_3x_exit_simulated' : 'target_3x_observed_legacy');
      continue;
    }
    if (observedTarget && row.signal === 'model_raw') {
      await closeAt(row.ca, row.signal, row.model_version, price, 'target_3x_observed_shadow');
      continue;
    }
    let reason: string | null = null;
    if (multiple <= executionSettings.stopMultiple) reason = `stop_${Math.round((1 - executionSettings.stopMultiple) * 100)}pct`;
    else if (token.state === 'DEAD') reason = 'coin_died';
    else if (ageHours >= executionSettings.maxHoldHours) reason = `time_${executionSettings.maxHoldHours}h`;
    if (reason) await closeAt(row.ca, row.signal, row.model_version, price, reason);
  }
}

async function closeAt(ca: string, signal: string, modelVersion: string, price: number | null, reason: string) {
  if (!pool) return;
  await pool.query(
    `UPDATE paper_trades SET closed=true,exit_at=now(),exit_reason=$4,
       exit_price=COALESCE($5,last_price,entry_price)
     WHERE ca=$1 AND signal=$2 AND model_version=$3 AND closed=false`,
    [ca, signal, modelVersion, reason, price],
  ).catch(() => {});
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
       ROUND(AVG(quote_time_ms) FILTER (WHERE quote_time_ms IS NOT NULL)::numeric,0) AS avg_quote_ms
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
  if (!pool) return { open: 0, total: 0, executable: 0, hit3x: 0, quotePending: 0, quoteStatuses: [] };
  const result = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE NOT closed) AS open,COUNT(*) AS total,
       COUNT(*) FILTER (WHERE execution_eligible) AS executable,COUNT(*) FILTER (WHERE transaction_built) AS transaction_built,
       COUNT(*) FILTER (WHERE simulation_ok) AS simulation_ok,COUNT(*) FILTER (WHERE observed_target_hit_at IS NOT NULL) AS observed_hit3x,
       COUNT(*) FILTER (WHERE execution_eligible AND target_hit_at IS NOT NULL) AS hit3x,
       COUNT(*) FILTER (WHERE quote_status='quote_pending') AS quote_pending,
       COUNT(*) FILTER (WHERE quote_status='jupiter_api_key_missing') AS missing_api_key,
       COUNT(*) FILTER (WHERE execution_eligible AND observed_target_hit_at IS NOT NULL AND target_hit_at IS NULL) AS exit_unverified
     FROM paper_trades`,
  ).catch(() => ({ rows: [{}] }));
  const row = result.rows[0] || {};
  return {
    open: numberValue(row.open), total: numberValue(row.total), executable: numberValue(row.executable),
    transactionBuilt: numberValue(row.transaction_built), simulationOk: numberValue(row.simulation_ok),
    observedHit3x: numberValue(row.observed_hit3x), hit3x: numberValue(row.hit3x),
    quotePending: numberValue(row.quote_pending), missingApiKey: numberValue(row.missing_api_key),
    exitUnverified: numberValue(row.exit_unverified), targetMultiple: executionSettings.targetMultiple,
    minForwardSamples: executionSettings.minForwardSamples, currentModel: MODEL_VERSION,
    quoteStatuses: await paperQuoteStatusBreakdown(30),
  };
}
