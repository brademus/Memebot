import { pool } from '../db';
import { getToken } from '../store';
import { executionSettings, quoteExecutableEntry } from './execution';

// ===== PAPER TRADING =====
// Each alert is captured immediately at its observed mark, then enriched with a
// quote-only Jupiter Swap V2 order. Executable performance uses the conservative
// effective entry after minimum slippage output and estimated network fees.

export type PaperSignal = 'trigger' | 'conviction' | 'bb_smart' | 'bb_organic' | 'bb_pregrad' | 'bb_secondwave';

// Insert first so repeated render/evaluation calls cannot trigger duplicate quotes.
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
     ON CONFLICT (ca, signal) DO NOTHING
     RETURNING id`,
    [ca, symbol, signal, markPrice, score, executionSettings.targetMultiple],
  ).catch(() => null);
  if (!inserted?.rowCount) return;

  const token = getToken(ca);
  if (!token) {
    await pool.query(
      `UPDATE paper_trades SET quote_status='token_not_in_memory'
       WHERE ca=$1 AND signal=$2`, [ca, signal]).catch(() => {});
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
            price_impact_pct = $9,
            slippage_bps = $10,
            fee_lamports = $11,
            router = $12,
            quote_time_ms = $13
      WHERE ca = $1 AND signal = $2`,
    [
      ca,
      signal,
      quote.eligible,
      quote.effectiveEntryPrice,
      quote.status,
      quote.positionSol,
      quote.positionUsd,
      quote.quotedOutUsd,
      quote.priceImpact,
      quote.slippageBps,
      quote.feeLamports,
      quote.router,
      quote.quoteTimeMs,
    ],
  ).catch(() => {});
}

// Fifteen seconds is deliberate: a one-minute sampler can miss a brief 3x wick and
// incorrectly call an early alert a failure. Market data itself may still be slower,
// which remains visible through quote and mark timestamps.
export function startPaperTrader() {
  if (!pool) return;
  setInterval(() => mark().catch(() => {}), 15_000);
}

async function mark() {
  if (!pool) return;
  const open = await pool.query(
    `SELECT ca, signal, entry_price, entry_at, peak_price, target_hit_at
       FROM paper_trades
      WHERE closed = false`).catch(() => ({ rows: [] as any[] }));

  for (const row of open.rows) {
    const t = getToken(row.ca);
    if (!t || !t.priceUsd || t.priceUsd <= 0) {
      if (!t) await closeAt(row.ca, row.signal, null, 'tracking_lost');
      continue;
    }

    const entry = Number(row.entry_price);
    if (!Number.isFinite(entry) || entry <= 0) continue;
    const price = t.priceUsd;
    const previousPeak = Number(row.peak_price) || entry;
    const peak = Math.max(previousPeak, price);
    const multiple = price / entry;
    const peakMultiple = peak / entry;
    const ageHours = (Date.now() - new Date(row.entry_at).getTime()) / 3_600_000;
    const firstTargetHit = !row.target_hit_at && peakMultiple >= executionSettings.targetMultiple;

    await pool.query(
      `UPDATE paper_trades
          SET last_price = $3,
              last_at = now(),
              peak_price = $4,
              peak_at = CASE WHEN $4 > peak_price THEN now() ELSE peak_at END,
              target_hit_at = CASE WHEN target_hit_at IS NULL AND $5 THEN now() ELSE target_hit_at END,
              seconds_to_target = CASE
                WHEN seconds_to_target IS NULL AND $5
                THEN EXTRACT(EPOCH FROM (now() - entry_at))::int
                ELSE seconds_to_target
              END
        WHERE ca = $1 AND signal = $2 AND closed = false`,
      [row.ca, row.signal, price, peak, firstTargetHit],
    ).catch(() => {});

    let reason: string | null = null;
    let exitPrice: number | null = price;
    if (peakMultiple >= executionSettings.targetMultiple) {
      reason = `target_${executionSettings.targetMultiple}x_hit`;
      exitPrice = entry * executionSettings.targetMultiple;
    } else if (multiple <= executionSettings.stopMultiple) {
      reason = `stop_${Math.round((1 - executionSettings.stopMultiple) * 100)}pct`;
    } else if (t.state === 'DEAD') {
      reason = 'coin_died';
    } else if (ageHours >= executionSettings.maxHoldHours) {
      reason = `time_${executionSettings.maxHoldHours}h`;
    }

    if (reason) await closeAt(row.ca, row.signal, exitPrice, reason);
  }
}

async function closeAt(ca: string, signal: string, price: number | null, reason: string) {
  if (!pool) return;
  await pool.query(
    `UPDATE paper_trades
        SET closed = true,
            exit_at = now(),
            exit_reason = $3,
            exit_price = COALESCE($4, last_price, entry_price)
      WHERE ca = $1 AND signal = $2 AND closed = false`,
    [ca, signal, reason, price],
  ).catch(() => {});
}

function numberValue(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

// Separate timing observations from executable evidence. A lane is never labeled
// evidence-ready until it has enough resolved forward executable calls.
export async function paperScoreboard(days = 30): Promise<any[]> {
  if (!pool) return [];
  const result = await pool.query(`
    SELECT signal,
           COUNT(*) AS observations,
           COUNT(*) FILTER (WHERE execution_eligible) AS executable,
           COUNT(*) FILTER (
             WHERE execution_eligible AND closed
               AND exit_reason IS DISTINCT FROM 'tracking_lost'
           ) AS resolved_executable,
           COUNT(*) FILTER (WHERE NOT execution_eligible) AS quote_ineligible,
           COUNT(*) FILTER (WHERE exit_reason = 'tracking_lost') AS incomplete,
           COUNT(*) FILTER (WHERE execution_eligible AND target_hit_at IS NOT NULL) AS hits_3x,
           ROUND(AVG(COALESCE(exit_price,last_price) / NULLIF(entry_price,0))
             FILTER (WHERE execution_eligible AND closed
               AND exit_reason IS DISTINCT FROM 'tracking_lost')::numeric, 3) AS avg_executable_return,
           ROUND((COUNT(*) FILTER (WHERE execution_eligible AND target_hit_at IS NOT NULL))::numeric
             / NULLIF(COUNT(*) FILTER (WHERE execution_eligible AND closed
               AND exit_reason IS DISTINCT FROM 'tracking_lost'),0) * 100, 1) AS pct_3x_executable,
           ROUND(MAX(peak_price / NULLIF(entry_price,0))
             FILTER (WHERE execution_eligible)::numeric, 2) AS best_executable,
           ROUND(AVG(seconds_to_target)
             FILTER (WHERE execution_eligible AND seconds_to_target IS NOT NULL) / 60.0, 1) AS avg_minutes_to_3x,
           PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY seconds_to_target)
             FILTER (WHERE execution_eligible AND seconds_to_target IS NOT NULL) / 60.0 AS median_minutes_to_3x,
           ROUND(AVG(price_impact_pct)
             FILTER (WHERE execution_eligible)::numeric, 4) AS avg_price_impact,
           ROUND(AVG(quote_time_ms)
             FILTER (WHERE quote_time_ms IS NOT NULL)::numeric, 0) AS avg_quote_ms
      FROM paper_trades
     WHERE entry_at > now() - ($1 || ' days')::interval
     GROUP BY signal
     ORDER BY pct_3x_executable DESC NULLS LAST`, [String(days)]).catch(() => null);

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
           COUNT(*) FILTER (WHERE execution_eligible AND target_hit_at IS NOT NULL) AS hit3x,
           COUNT(*) FILTER (WHERE quote_status = 'quote_pending') AS quote_pending,
           COUNT(*) FILTER (WHERE quote_status = 'jupiter_api_key_missing') AS missing_api_key
      FROM paper_trades`).catch(() => ({ rows: [{}] }));
  const row = result.rows[0] || {};
  return {
    open: numberValue(row.open),
    total: numberValue(row.total),
    executable: numberValue(row.executable),
    hit3x: numberValue(row.hit3x),
    quotePending: numberValue(row.quote_pending),
    missingApiKey: numberValue(row.missing_api_key),
    targetMultiple: executionSettings.targetMultiple,
    minForwardSamples: executionSettings.minForwardSamples,
  };
}
