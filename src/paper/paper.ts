import { pool } from '../db';
import { getToken } from '../store';
import { executionSettings, quoteExecutableEntry, quoteExecutableExit } from './execution';

export type PaperSignal = 'trigger' | 'conviction' | 'bb_smart' | 'bb_organic' | 'bb_pregrad' | 'bb_secondwave';

export async function openPaper(
  ca: string,
  symbol: string,
  signal: PaperSignal,
  markPrice: number,
  score: number | null,
) {
  if (!pool || !markPrice || markPrice <= 0) return;
  const inserted = await pool.query(
    `INSERT INTO paper_trades
       (ca, symbol, signal, entry_price, mark_entry_price, entry_score,
        peak_price, peak_at, last_price, last_at, target_multiple, quote_status)
     VALUES ($1,$2,$3,$4,$4,$5,$4,now(),$4,now(),$6,'quote_pending')
     ON CONFLICT (ca, signal) DO NOTHING RETURNING id`,
    [ca, symbol, signal, markPrice, score, executionSettings.targetMultiple],
  ).catch(() => null);
  if (!inserted?.rowCount) return;

  const token = getToken(ca);
  if (!token) {
    await pool.query(`UPDATE paper_trades SET quote_status='token_not_in_memory' WHERE ca=$1 AND signal=$2`, [ca, signal]).catch(() => {});
    return;
  }

  const quote = await quoteExecutableEntry(token, markPrice);
  await pool.query(
    `UPDATE paper_trades
        SET entry_price = CASE WHEN $3 THEN $4 ELSE entry_price END,
            execution_eligible = $3,
            quote_status = $5,
            position_sol = $6,
            position_usd = $7,
            quoted_out_usd = $8,
            quoted_out_amount = $9,
            price_impact_pct = $10,
            slippage_bps = $11,
            fee_lamports = $12,
            router = $13,
            quote_time_ms = $14
      WHERE ca = $1 AND signal = $2`,
    [ca, signal, quote.eligible, quote.effectiveEntryPrice, quote.status,
     quote.positionSol, quote.positionUsd, quote.quotedOutUsd, quote.quotedOutAmount,
     quote.priceImpact, quote.slippageBps, quote.feeLamports, quote.router, quote.quoteTimeMs],
  ).catch(() => {});
}

export function startPaperTrader() {
  if (!pool) return;
  setInterval(() => mark().catch(error => console.error('[paper]', error.message)), 15_000);
}

async function mark() {
  if (!pool) return;
  const open = await pool.query(
    `SELECT ca, signal, entry_price, entry_at, peak_price, target_hit_at,
            observed_target_hit_at, execution_eligible, position_usd,
            quoted_out_amount, exit_quote_status
       FROM paper_trades WHERE closed = false`).catch(() => ({ rows: [] as any[] }));

  for (const row of open.rows) {
    const token = getToken(row.ca);
    if (!token || !token.priceUsd || token.priceUsd <= 0) {
      if (!token) await closeAt(row.ca, row.signal, null, 'tracking_lost');
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
      `UPDATE paper_trades
          SET last_price=$3, last_at=now(), peak_price=$4,
              peak_at=CASE WHEN $4 > peak_price THEN now() ELSE peak_at END,
              observed_target_hit_at=CASE
                WHEN observed_target_hit_at IS NULL AND $5 THEN now()
                ELSE observed_target_hit_at END
        WHERE ca=$1 AND signal=$2 AND closed=false`,
      [row.ca, row.signal, price, peak, observedTarget],
    ).catch(() => {});

    let verifiedTarget = false;
    let verifiedExitPrice: number | null = null;

    if (observedTarget && !row.target_hit_at) {
      if (!row.execution_eligible) {
        // Legacy rows remain visible as observed results but are never included in
        // executable evidence because execution_eligible is false.
        verifiedTarget = true;
        verifiedExitPrice = entry * executionSettings.targetMultiple;
      } else if (row.quoted_out_amount && Number(row.position_usd) > 0) {
        const exitQuote = await quoteExecutableExit(row.ca, String(row.quoted_out_amount));
        const realizedMultiple = exitQuote.eligible && exitQuote.proceedsUsd
          ? exitQuote.proceedsUsd / Number(row.position_usd)
          : 0;
        await pool.query(
          `UPDATE paper_trades
              SET exit_quote_status=$3, exit_quoted_usd=$4,
                  exit_price_impact_pct=$5, exit_fee_lamports=$6,
                  exit_router=$7, exit_quote_time_ms=$8
            WHERE ca=$1 AND signal=$2`,
          [row.ca, row.signal, exitQuote.status, exitQuote.proceedsUsd,
           exitQuote.priceImpact, exitQuote.feeLamports, exitQuote.router, exitQuote.quoteTimeMs],
        ).catch(() => {});
        if (exitQuote.eligible && realizedMultiple >= executionSettings.targetMultiple) {
          verifiedTarget = true;
          verifiedExitPrice = entry * realizedMultiple;
        }
      }
    }

    if (verifiedTarget) {
      await pool.query(
        `UPDATE paper_trades
            SET target_hit_at=COALESCE(target_hit_at,now()),
                seconds_to_target=COALESCE(seconds_to_target,EXTRACT(EPOCH FROM (now()-entry_at))::int)
          WHERE ca=$1 AND signal=$2`, [row.ca, row.signal]).catch(() => {});
      await closeAt(row.ca, row.signal, verifiedExitPrice, row.execution_eligible ? 'target_3x_exit_verified' : 'target_3x_observed_legacy');
      continue;
    }

    let reason: string | null = null;
    if (multiple <= executionSettings.stopMultiple) reason = `stop_${Math.round((1 - executionSettings.stopMultiple) * 100)}pct`;
    else if (token.state === 'DEAD') reason = 'coin_died';
    else if (ageHours >= executionSettings.maxHoldHours) reason = `time_${executionSettings.maxHoldHours}h`;
    if (reason) await closeAt(row.ca, row.signal, price, reason);
  }
}

async function closeAt(ca: string, signal: string, price: number | null, reason: string) {
  if (!pool) return;
  await pool.query(
    `UPDATE paper_trades
        SET closed=true, exit_at=now(), exit_reason=$3,
            exit_price=COALESCE($4,last_price,entry_price)
      WHERE ca=$1 AND signal=$2 AND closed=false`,
    [ca, signal, reason, price],
  ).catch(() => {});
}

function numberValue(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

export async function paperScoreboard(days = 30): Promise<any[]> {
  if (!pool) return [];
  const result = await pool.query(`
    SELECT signal,
           COUNT(*) AS observations,
           COUNT(*) FILTER (WHERE execution_eligible) AS executable,
           COUNT(*) FILTER (WHERE execution_eligible AND closed AND exit_reason IS DISTINCT FROM 'tracking_lost') AS resolved_executable,
           COUNT(*) FILTER (WHERE NOT execution_eligible) AS quote_ineligible,
           COUNT(*) FILTER (WHERE exit_reason='tracking_lost') AS incomplete,
           COUNT(*) FILTER (WHERE observed_target_hit_at IS NOT NULL) AS observed_hits_3x,
           COUNT(*) FILTER (WHERE execution_eligible AND target_hit_at IS NOT NULL) AS hits_3x,
           ROUND(AVG(COALESCE(exit_price,last_price)/NULLIF(entry_price,0))
             FILTER (WHERE execution_eligible AND closed AND exit_reason IS DISTINCT FROM 'tracking_lost')::numeric,3) AS avg_executable_return,
           ROUND((COUNT(*) FILTER (WHERE execution_eligible AND target_hit_at IS NOT NULL))::numeric
             / NULLIF(COUNT(*) FILTER (WHERE execution_eligible AND closed AND exit_reason IS DISTINCT FROM 'tracking_lost'),0)*100,1) AS pct_3x_executable,
           ROUND(MAX(peak_price/NULLIF(entry_price,0)) FILTER (WHERE execution_eligible)::numeric,2) AS best_observed_from_executable_entry,
           ROUND(AVG(seconds_to_target) FILTER (WHERE execution_eligible AND seconds_to_target IS NOT NULL)/60.0,1) AS avg_minutes_to_3x,
           PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY seconds_to_target)
             FILTER (WHERE execution_eligible AND seconds_to_target IS NOT NULL)/60.0 AS median_minutes_to_3x,
           ROUND(AVG(price_impact_pct) FILTER (WHERE execution_eligible)::numeric,4) AS avg_entry_price_impact,
           ROUND(AVG(exit_price_impact_pct) FILTER (WHERE target_hit_at IS NOT NULL AND execution_eligible)::numeric,4) AS avg_exit_price_impact,
           ROUND(AVG(quote_time_ms) FILTER (WHERE quote_time_ms IS NOT NULL)::numeric,0) AS avg_quote_ms
      FROM paper_trades
     WHERE entry_at > now()-($1||' days')::interval
     GROUP BY signal ORDER BY pct_3x_executable DESC NULLS LAST`, [String(days)]).catch(() => null);

  return (result?.rows || []).map((row: any) => {
    const resolved = numberValue(row.resolved_executable);
    return {
      ...row,
      forward_ready: resolved >= executionSettings.minForwardSamples,
      evidence_status: resolved >= executionSettings.minForwardSamples
        ? `evidence-ready (${resolved} resolved executable calls)`
        : `collecting (${resolved}/${executionSettings.minForwardSamples} resolved executable calls)`,
    };
  });
}

export async function paperDiag() {
  if (!pool) return { open: 0, total: 0, executable: 0, hit3x: 0, quotePending: 0 };
  const result = await pool.query(`
    SELECT COUNT(*) FILTER (WHERE NOT closed) AS open,
           COUNT(*) AS total,
           COUNT(*) FILTER (WHERE execution_eligible) AS executable,
           COUNT(*) FILTER (WHERE observed_target_hit_at IS NOT NULL) AS observed_hit3x,
           COUNT(*) FILTER (WHERE execution_eligible AND target_hit_at IS NOT NULL) AS hit3x,
           COUNT(*) FILTER (WHERE quote_status='quote_pending') AS quote_pending,
           COUNT(*) FILTER (WHERE quote_status='jupiter_api_key_missing') AS missing_api_key,
           COUNT(*) FILTER (WHERE execution_eligible AND observed_target_hit_at IS NOT NULL AND target_hit_at IS NULL) AS exit_unverified
      FROM paper_trades`).catch(() => ({ rows: [{}] }));
  const row = result.rows[0] || {};
  return {
    open: numberValue(row.open), total: numberValue(row.total), executable: numberValue(row.executable),
    observedHit3x: numberValue(row.observed_hit3x), hit3x: numberValue(row.hit3x),
    quotePending: numberValue(row.quote_pending), missingApiKey: numberValue(row.missing_api_key),
    exitUnverified: numberValue(row.exit_unverified), targetMultiple: executionSettings.targetMultiple,
    minForwardSamples: executionSettings.minForwardSamples,
  };
}
