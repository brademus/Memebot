import { pool } from '../db';
import { getToken } from '../store';
import { finalizePaperTelemetry } from './telemetry';

export const HYPOTHETICAL_STAKE_USD = 100;
export const TAKE_PROFIT_MULTIPLE = 3;
export const STOP_LOSS_MULTIPLE = 0.5;

export type HypotheticalExitReason = 'take_profit_3x' | 'stop_loss_50pct';

export function hypotheticalExitDecision(entryPrice: number, markPrice: number): {
  reason: HypotheticalExitReason;
  exitPrice: number;
  multiple: number;
  proceedsUsd: number;
  pnlUsd: number;
} | null {
  if (!Number.isFinite(entryPrice) || entryPrice <= 0 || !Number.isFinite(markPrice) || markPrice <= 0) return null;

  const multiple = markPrice / entryPrice;
  if (multiple >= TAKE_PROFIT_MULTIPLE) {
    return {
      reason: 'take_profit_3x',
      exitPrice: entryPrice * TAKE_PROFIT_MULTIPLE,
      multiple: TAKE_PROFIT_MULTIPLE,
      proceedsUsd: HYPOTHETICAL_STAKE_USD * TAKE_PROFIT_MULTIPLE,
      pnlUsd: HYPOTHETICAL_STAKE_USD * (TAKE_PROFIT_MULTIPLE - 1),
    };
  }

  if (multiple <= STOP_LOSS_MULTIPLE) {
    return {
      reason: 'stop_loss_50pct',
      exitPrice: entryPrice * STOP_LOSS_MULTIPLE,
      multiple: STOP_LOSS_MULTIPLE,
      proceedsUsd: HYPOTHETICAL_STAKE_USD * STOP_LOSS_MULTIPLE,
      pnlUsd: HYPOTHETICAL_STAKE_USD * (STOP_LOSS_MULTIPLE - 1),
    };
  }

  return null;
}

async function enforceExitPolicy() {
  if (!pool) return;

  const open = await pool.query(
    `SELECT id,ca,entry_price,last_price,peak_price
       FROM paper_trades
      WHERE closed=false`,
  ).catch(() => ({ rows: [] as any[] }));

  for (const row of open.rows) {
    const entry = Number(row.entry_price);
    const token = getToken(row.ca);
    const liveMark = token && token.priceUsd > 0 ? token.priceUsd : Number(row.last_price);
    const peakMark = Math.max(Number(row.peak_price) || 0, liveMark || 0);

    const targetDecision = hypotheticalExitDecision(entry, peakMark);
    const decision = targetDecision?.reason === 'take_profit_3x'
      ? targetDecision
      : hypotheticalExitDecision(entry, liveMark);
    if (!decision) continue;

    const closed = await pool.query(
      `UPDATE paper_trades
          SET closed=true,
              exit_at=now(),
              exit_reason=$2,
              exit_price=$3,
              last_price=$3,
              last_at=now(),
              target_hit_at=CASE WHEN $2='take_profit_3x' THEN COALESCE(target_hit_at,now()) ELSE target_hit_at END,
              observed_target_hit_at=CASE WHEN $2='take_profit_3x' THEN COALESCE(observed_target_hit_at,now()) ELSE observed_target_hit_at END,
              seconds_to_target=CASE WHEN $2='take_profit_3x'
                THEN COALESCE(seconds_to_target,EXTRACT(EPOCH FROM (now()-entry_at))::int)
                ELSE seconds_to_target END
        WHERE id=$1 AND closed=false
        RETURNING id`,
      [row.id, decision.reason, decision.exitPrice],
    ).catch(() => null);
    if (!closed?.rowCount) continue;

    await finalizePaperTelemetry(Number(row.id), token || null, decision.exitPrice, decision.reason);
    console.log(
      `[paper-policy] hypothetical $${HYPOTHETICAL_STAKE_USD} position closed: ${decision.reason}; `
      + `${decision.multiple.toFixed(1)}x; pnl=$${decision.pnlUsd.toFixed(2)}`,
    );
  }
}

export function startHypotheticalExitPolicy() {
  if (!pool) return;
  void enforceExitPolicy().catch(error => console.error('[paper-policy]', error.message));
  const timer = setInterval(
    () => void enforceExitPolicy().catch(error => console.error('[paper-policy]', error.message)),
    5_000,
  );
  timer.unref();
}
