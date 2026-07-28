import { pool } from '../db';
import { STRATEGY_VERSION } from './strategy-policy';

const INTERVAL_MS = 30_000;
let started = false;
let running = false;
const diag = {
  runs: 0,
  repairedRows: 0,
  lastRunAt: null as string | null,
  lastSuccessAt: null as string | null,
  lastError: null as string | null,
};

export const strategyExtremaReconcilerDiag = () => ({
  enabled: !!pool,
  intervalSeconds: INTERVAL_MS / 1000,
  strategyVersion: STRATEGY_VERSION,
  ...diag,
});

export async function reconcileStrategyExitExtrema(): Promise<number> {
  if (!pool || running) return 0;
  running = true;
  diag.runs++;
  diag.lastRunAt = new Date().toISOString();
  try {
    // Adaptive exits can happen between 15-second market snapshots. Include the final
    // observed exit mark in MFE/MAE so a 3x close cannot report only 129% runup and a
    // -40% close cannot report a shallower drawdown captured before the sale.
    const result = await pool.query({
      text: `UPDATE paper_trades SET
        peak_at=CASE WHEN exit_price>COALESCE(peak_price,entry_price)
          THEN COALESCE(exit_at,peak_at,entry_at) ELSE peak_at END,
        peak_price=GREATEST(COALESCE(peak_price,entry_price),exit_price),
        trough_at=CASE WHEN exit_price<COALESCE(trough_price,entry_price)
          THEN COALESCE(exit_at,trough_at,entry_at) ELSE trough_at END,
        trough_price=LEAST(COALESCE(trough_price,entry_price),exit_price),
        max_runup_pct=GREATEST(COALESCE(max_runup_pct,0),
          GREATEST(0,(exit_price/NULLIF(entry_price,0)-1)*100)),
        max_drawdown_pct=LEAST(COALESCE(max_drawdown_pct,0),
          LEAST(0,(exit_price/NULLIF(entry_price,0)-1)*100))
      WHERE strategy_version=$1 AND closed=true AND entry_price>0 AND exit_price>0
        AND (exit_price>COALESCE(peak_price,entry_price)
          OR exit_price<COALESCE(trough_price,entry_price)
          OR COALESCE(max_runup_pct,0)<GREATEST(0,(exit_price/NULLIF(entry_price,0)-1)*100)
          OR COALESCE(max_drawdown_pct,0)>LEAST(0,(exit_price/NULLIF(entry_price,0)-1)*100))`,
      values: [STRATEGY_VERSION],
      query_timeout: 12_000,
    } as any);
    const repaired = Number(result.rowCount || 0);
    diag.repairedRows += repaired;
    diag.lastSuccessAt = new Date().toISOString();
    diag.lastError = null;
    if (repaired) console.log(`[strategy-extrema] repaired ${repaired} closed strategy row(s)`);
    return repaired;
  } catch (error) {
    diag.lastError = (error as Error).message.slice(0, 400);
    console.error('[strategy-extrema]', diag.lastError);
    return 0;
  } finally {
    running = false;
  }
}

export function startStrategyExtremaReconciler() {
  if (started || !pool) return;
  started = true;
  void reconcileStrategyExitExtrema();
  const timer = setInterval(() => void reconcileStrategyExitExtrema(), INTERVAL_MS);
  timer.unref();
  console.log('[strategy-extrema] final exit marks are included in strategy MFE/MAE');
}
