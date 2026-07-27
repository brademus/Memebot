import { pool } from '../db';
import { ensureStrategyLifecycleSchema } from './strategy-lifecycle';
import { STRATEGY_VERSION } from './strategy-policy';

const INTERVAL_MS = 30_000;
let started = false;
let running = false;
const diag = {
  runs: 0,
  qualityRecovered: 0,
  entryRecovered: 0,
  exitRecovered: 0,
  lastSuccessAt: null as string | null,
  lastError: null as string | null,
};

export const strategyLedgerReconcilerDiag = () => ({
  enabled: !!pool,
  intervalSeconds: INTERVAL_MS / 1000,
  running,
  ...diag,
});

async function reconcile() {
  if (!pool || running) return;
  running = true;
  diag.runs++;
  try {
    const epochAt = await ensureStrategyLifecycleSchema();
    const quality = await pool.query(`INSERT INTO strategy_decisions
        (paper_trade_id,ca,symbol,model_version,strategy_version,stage,decision,reason_code,reasons,
         at,price_usd,score,metrics,evidence,dedupe_key)
      SELECT p.id,p.ca,p.symbol,p.model_version,$2,'quality','candidate_selected',
        COALESCE(p.quality_decision->>'lane','unknown') || '_quality_selected',
        COALESCE(ARRAY(SELECT jsonb_array_elements_text(p.quality_decision->'reasons')),'{}'::text[]),
        p.entry_at,p.entry_price,p.entry_score,COALESCE(p.quality_decision->'metrics','{}'::jsonb),
        p.quality_decision,'quality:selected'
      FROM paper_trades p
      WHERE p.entry_at>=$1::timestamptz AND p.strategy_version=$2
        AND p.strategy_role='quality_observation' AND p.quality_decision IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM strategy_decisions d
          WHERE d.paper_trade_id=p.id AND d.stage='quality' AND d.dedupe_key='quality:selected')
      ON CONFLICT (paper_trade_id,stage,dedupe_key) DO NOTHING RETURNING id`, [epochAt, STRATEGY_VERSION]);

    const entry = await pool.query(`INSERT INTO strategy_decisions
        (paper_trade_id,ca,symbol,model_version,strategy_version,stage,decision,reason_code,reasons,
         at,price_usd,score,metrics,evidence,dedupe_key)
      SELECT p.id,p.ca,p.symbol,p.model_version,$2,'entry','buy','timing_gate_buy',
        COALESCE(ARRAY(SELECT jsonb_array_elements_text(p.entry_decision->'reasons')),'{}'::text[]),
        p.entry_at,p.entry_price,p.entry_score,COALESCE(p.entry_decision->'timing','{}'::jsonb),
        p.entry_decision,'entry:buy'
      FROM paper_trades p
      WHERE p.entry_at>=$1::timestamptz AND p.strategy_version=$2
        AND p.strategy_role='timed_entry' AND p.entry_decision IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM strategy_decisions d
          WHERE d.paper_trade_id=p.id AND d.stage='entry' AND d.dedupe_key='entry:buy')
      ON CONFLICT (paper_trade_id,stage,dedupe_key) DO NOTHING RETURNING id`, [epochAt, STRATEGY_VERSION]);

    const exit = await pool.query(`INSERT INTO strategy_decisions
        (paper_trade_id,ca,symbol,model_version,strategy_version,stage,decision,reason_code,reasons,
         at,price_usd,score,metrics,evidence,dedupe_key)
      SELECT p.id,p.ca,p.symbol,p.model_version,$2,'exit',
        COALESCE(p.exit_decision->>'decision','sell'),
        COALESCE(p.exit_decision->>'reasonCode',p.exit_reason,'external_close'),
        COALESCE(ARRAY(SELECT jsonb_array_elements_text(p.exit_decision->'reasons')),'{}'::text[]),
        COALESCE(p.exit_at,now()),p.exit_price,p.entry_score,
        COALESCE(p.exit_decision->'metrics',jsonb_build_object('finalMultiple',p.final_multiple,'realizedPnlUsd',p.realized_pnl_usd)),
        p.exit_decision,
        'exit:sell:' || COALESCE(p.exit_decision->>'reasonCode',p.exit_reason,'external_close')
      FROM paper_trades p
      WHERE p.entry_at>=$1::timestamptz AND p.strategy_version=$2
        AND p.closed=true AND p.exit_decision IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM strategy_decisions d
          WHERE d.paper_trade_id=p.id AND d.stage='exit' AND d.decision='sell')
      ON CONFLICT (paper_trade_id,stage,dedupe_key) DO NOTHING RETURNING id`, [epochAt, STRATEGY_VERSION]);

    diag.qualityRecovered += Number(quality.rowCount || 0);
    diag.entryRecovered += Number(entry.rowCount || 0);
    diag.exitRecovered += Number(exit.rowCount || 0);
    diag.lastSuccessAt = new Date().toISOString();
    diag.lastError = null;
  } catch (error) {
    diag.lastError = (error as Error).message.slice(0, 400);
    console.error('[strategy-ledger-reconciler]', diag.lastError);
  } finally {
    running = false;
  }
}

export function startStrategyLedgerReconciler() {
  if (!pool || started) return;
  started = true;
  void reconcile();
  const timer = setInterval(() => void reconcile(), INTERVAL_MS);
  timer.unref();
}
