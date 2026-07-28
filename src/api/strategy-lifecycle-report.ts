import { pool } from '../db';
import {
  ensureStrategyLifecycleSchema,
  strategyLifecycleDiag,
} from '../paper/strategy-lifecycle';
import {
  ADAPTIVE_EXIT_POLICY,
  STRATEGY_NOTIONAL_USD,
  STRATEGY_VERSION,
} from '../paper/strategy-policy';
import { entryRevalidationDiag } from '../scoring/entry-revalidation';

const number = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export async function buildStrategyLifecycleReport(days = 1) {
  const boundedDays = Math.max(1, Math.min(30, Math.floor(days) || 1));
  if (!pool) return { available: false, reason: 'database_unavailable' };

  const errors: string[] = [];
  const query = async (name: string, text: string, values: unknown[] = []) => {
    try {
      return (await pool!.query({ text, values, query_timeout: 12_000 } as any)).rows;
    } catch (error) {
      errors.push(`${name}: ${(error as Error).message}`);
      return [];
    }
  };

  let epochAt: string;
  try {
    epochAt = await ensureStrategyLifecycleSchema();
  } catch (error) {
    return { available: false, reason: 'strategy_schema_unavailable', error: (error as Error).message };
  }
  const requestedStart = Date.now() - boundedDays * 86_400_000;
  const windowStart = new Date(Math.max(requestedStart, Date.parse(epochAt))).toISOString();

  const [summaryRows, roleRows, pairSummaryRows, pairRows, exitRows, waitRows,
    completenessRows, decisionCountRows, decisionRows, openRows, unconvertedRows] = await Promise.all([
    query('strategy summary', `SELECT
      COUNT(*) FILTER (WHERE strategy_role='quality_observation')::int AS quality_observations,
      COUNT(*) FILTER (WHERE strategy_role='timed_entry')::int AS timed_entries,
      COUNT(*) FILTER (WHERE strategy_role='timed_entry' AND closed)::int AS timed_entries_closed,
      COUNT(*) FILTER (WHERE strategy_role='timed_entry' AND NOT closed)::int AS timed_entries_open,
      COUNT(*) FILTER (WHERE strategy_role='timed_entry' AND closed AND exit_reason IS DISTINCT FROM 'tracking_lost')::int AS timed_entries_resolved,
      COUNT(*) FILTER (WHERE strategy_role='timed_entry' AND closed AND final_multiple>=3)::int AS timed_entries_reached_3x,
      ROUND((AVG(final_multiple) FILTER (WHERE strategy_role='timed_entry' AND closed AND exit_reason IS DISTINCT FROM 'tracking_lost'))::numeric,3) AS timed_entry_avg_multiple,
      ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY final_multiple)
        FILTER (WHERE strategy_role='timed_entry' AND closed AND exit_reason IS DISTINCT FROM 'tracking_lost'))::numeric,3) AS timed_entry_median_multiple,
      ROUND((SUM(realized_pnl_usd) FILTER (WHERE strategy_role='timed_entry' AND closed AND exit_reason IS DISTINCT FROM 'tracking_lost'))::numeric,2) AS timed_entry_realized_pnl_usd,
      COUNT(*) FILTER (WHERE strategy_role='quality_observation' AND closed AND exit_reason IS DISTINCT FROM 'tracking_lost')::int AS quality_benchmarks_resolved,
      ROUND((AVG(final_multiple) FILTER (WHERE strategy_role='quality_observation' AND closed AND exit_reason IS DISTINCT FROM 'tracking_lost'))::numeric,3) AS quality_benchmark_avg_multiple,
      ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY final_multiple)
        FILTER (WHERE strategy_role='quality_observation' AND closed AND exit_reason IS DISTINCT FROM 'tracking_lost'))::numeric,3) AS quality_benchmark_median_multiple
      FROM paper_trades WHERE entry_at>=$1::timestamptz AND strategy_version=$2`, [windowStart, STRATEGY_VERSION]),
    query('performance by strategy role', `SELECT strategy_role,COUNT(*)::int AS records,
      COUNT(*) FILTER (WHERE closed)::int AS closed,
      COUNT(*) FILTER (WHERE closed AND exit_reason IS DISTINCT FROM 'tracking_lost')::int AS resolved,
      COUNT(*) FILTER (WHERE closed AND final_multiple>=3)::int AS reached_3x,
      ROUND((AVG(final_multiple) FILTER (WHERE closed AND exit_reason IS DISTINCT FROM 'tracking_lost'))::numeric,3) AS avg_final_multiple,
      ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY final_multiple)
        FILTER (WHERE closed AND exit_reason IS DISTINCT FROM 'tracking_lost'))::numeric,3) AS median_final_multiple,
      ROUND((AVG(max_runup_pct) FILTER (WHERE closed AND exit_reason IS DISTINCT FROM 'tracking_lost'))::numeric,2) AS avg_max_runup_pct,
      ROUND((AVG(max_drawdown_pct) FILTER (WHERE closed AND exit_reason IS DISTINCT FROM 'tracking_lost'))::numeric,2) AS avg_max_drawdown_pct,
      ROUND(COALESCE(SUM(realized_pnl_usd),0)::numeric,2) AS realized_pnl_usd
      FROM paper_trades WHERE entry_at>=$1::timestamptz AND strategy_version=$2
      GROUP BY strategy_role ORDER BY records DESC`, [windowStart, STRATEGY_VERSION]),
    query('quality to entry timing summary', `SELECT COUNT(*)::int AS paired_entries,
      ROUND((AVG(EXTRACT(EPOCH FROM (t.entry_at-q.entry_at)))::numeric),1) AS avg_seconds_quality_to_entry,
      ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (t.entry_at-q.entry_at))))::numeric,1) AS median_seconds_quality_to_entry,
      ROUND((AVG((t.entry_price/q.entry_price-1)*100)::numeric),2) AS avg_entry_price_change_pct,
      ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY (t.entry_price/q.entry_price-1)*100))::numeric,2) AS median_entry_price_change_pct,
      COUNT(*) FILTER (WHERE t.entry_price<q.entry_price)::int AS entries_below_quality_price,
      COUNT(*) FILTER (WHERE t.entry_price>=q.entry_price)::int AS entries_at_or_above_quality_price
      FROM paper_trades t JOIN paper_trades q ON q.id=t.parent_observation_id
      WHERE t.entry_at>=$1::timestamptz AND t.strategy_role='timed_entry' AND t.strategy_version=$2`,
    [windowStart, STRATEGY_VERSION]),
    query('paired quality and entry records', `SELECT
      t.id AS timed_entry_id,t.ca,t.symbol,t.entry_at AS buy_at,t.entry_price AS buy_price,
      t.entry_score AS buy_score,t.entry_decision,t.closed AS buy_closed,t.exit_at AS buy_exit_at,
      t.exit_reason AS buy_exit_reason,t.final_multiple AS buy_final_multiple,t.max_runup_pct AS buy_max_runup_pct,
      t.max_drawdown_pct AS buy_max_drawdown_pct,t.realized_pnl_usd,t.exit_decision,
      q.id AS quality_observation_id,q.signal AS quality_signal,q.entry_at AS quality_at,
      q.entry_price AS quality_price,q.entry_score AS quality_score,q.quality_decision,
      q.closed AS quality_closed,q.exit_reason AS quality_exit_reason,q.final_multiple AS quality_final_multiple,
      q.max_runup_pct AS quality_max_runup_pct,q.max_drawdown_pct AS quality_max_drawdown_pct,
      ROUND(EXTRACT(EPOCH FROM (t.entry_at-q.entry_at))::numeric,1) AS seconds_quality_to_entry,
      ROUND(((t.entry_price/q.entry_price-1)*100)::numeric,2) AS entry_price_change_pct
      FROM paper_trades t JOIN paper_trades q ON q.id=t.parent_observation_id
      WHERE t.entry_at>=$1::timestamptz AND t.strategy_role='timed_entry' AND t.strategy_version=$2
      ORDER BY t.entry_at`, [windowStart, STRATEGY_VERSION]),
    query('exit reason performance', `SELECT exit_reason,COUNT(*)::int AS exits,
      ROUND((AVG(final_multiple) FILTER (WHERE exit_reason IS DISTINCT FROM 'tracking_lost'))::numeric,3) AS avg_multiple,
      ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY final_multiple)
        FILTER (WHERE exit_reason IS DISTINCT FROM 'tracking_lost'))::numeric,3) AS median_multiple,
      ROUND(COALESCE(SUM(realized_pnl_usd),0)::numeric,2) AS realized_pnl_usd,
      ROUND((AVG(max_runup_pct))::numeric,2) AS avg_max_runup_pct,
      ROUND((AVG(max_drawdown_pct))::numeric,2) AS avg_max_drawdown_pct
      FROM paper_trades WHERE exit_at>=$1::timestamptz AND strategy_version=$2 AND strategy_role='timed_entry'
      GROUP BY exit_reason ORDER BY exits DESC`, [windowStart, STRATEGY_VERSION]),
    query('entry wait and skip reasons', `SELECT decision,reason_code,COUNT(*)::int AS observations
      FROM strategy_decisions WHERE at>=$1::timestamptz AND strategy_version=$2 AND stage='entry'
        AND decision IN ('wait','ready','skip')
      GROUP BY decision,reason_code ORDER BY observations DESC`, [windowStart, STRATEGY_VERSION]),
    query('strategy data completeness', `SELECT COUNT(*)::int AS records,
      COUNT(*) FILTER (WHERE strategy_role='quality_observation')::int AS quality_records,
      COUNT(*) FILTER (WHERE strategy_role='quality_observation' AND quality_decision IS NOT NULL)::int AS quality_with_reason,
      COUNT(*) FILTER (WHERE strategy_role='timed_entry')::int AS timed_entries,
      COUNT(*) FILTER (WHERE strategy_role='timed_entry' AND entry_decision IS NOT NULL)::int AS timed_entries_with_reason,
      COUNT(*) FILTER (WHERE strategy_role='timed_entry' AND last_exit_evaluation IS NOT NULL)::int AS timed_entries_with_exit_evaluation,
      COUNT(*) FILTER (WHERE strategy_role='timed_entry' AND closed)::int AS timed_entries_closed,
      COUNT(*) FILTER (WHERE strategy_role='timed_entry' AND closed AND exit_decision IS NOT NULL)::int AS timed_entries_with_exit_reason,
      COUNT(*) FILTER (WHERE strategy_role='timed_entry' AND parent_observation_id IS NOT NULL)::int AS timed_entries_linked_to_quality
      FROM paper_trades WHERE entry_at>=$1::timestamptz AND strategy_version=$2`, [windowStart, STRATEGY_VERSION]),
    query('decision ledger count', `SELECT COUNT(*)::int AS n FROM strategy_decisions
      WHERE at>=$1::timestamptz AND strategy_version=$2`, [windowStart, STRATEGY_VERSION]),
    query('decision ledger', `SELECT id,paper_trade_id,ca,symbol,model_version,stage,decision,reason_code,reasons,
      at,price_usd,score,metrics,evidence,dedupe_key
      FROM strategy_decisions WHERE at>=$1::timestamptz AND strategy_version=$2
      ORDER BY at,id LIMIT 5000`, [windowStart, STRATEGY_VERSION]),
    query('open timed entries', `SELECT id,ca,symbol,entry_at,entry_price,entry_score,parent_observation_id,
      entry_decision,last_price,peak_price,max_runup_pct,max_drawdown_pct,last_exit_evaluated_at,last_exit_evaluation
      FROM paper_trades WHERE strategy_version=$1 AND strategy_role='timed_entry' AND closed=false
      ORDER BY entry_at`, [STRATEGY_VERSION]),
    query('quality candidates without timed entry', `SELECT q.id,q.ca,q.symbol,q.signal,q.entry_at,q.entry_price,q.entry_score,
      q.quality_decision,q.closed,q.exit_reason,q.final_multiple,q.max_runup_pct,q.max_drawdown_pct,
      (SELECT jsonb_agg(jsonb_build_object('at',d.at,'decision',d.decision,'reasonCode',d.reason_code,
        'reasons',d.reasons,'metrics',d.metrics) ORDER BY d.at)
       FROM strategy_decisions d WHERE d.paper_trade_id=q.id AND d.stage='entry') AS entry_timing_ledger
      FROM paper_trades q
      WHERE q.entry_at>=$1::timestamptz AND q.strategy_version=$2 AND q.strategy_role='quality_observation'
        AND NOT EXISTS (SELECT 1 FROM paper_trades t WHERE t.parent_observation_id=q.id AND t.strategy_role='timed_entry')
      ORDER BY q.entry_at`, [windowStart, STRATEGY_VERSION]),
  ]);

  const summary: any = summaryRows[0] || {};
  const quality = Number(summary.quality_observations || 0);
  const entries = Number(summary.timed_entries || 0);
  const resolved = Number(summary.timed_entries_resolved || 0);
  const reached3x = Number(summary.timed_entries_reached_3x || 0);
  const totalDecisions = Number(decisionCountRows[0]?.n || 0);

  return {
    available: true,
    reportType: 'strategy_lifecycle_evidence',
    strategyVersion: STRATEGY_VERSION,
    evidenceEpochAt: epochAt,
    windowStart,
    windowDaysRequested: boundedDays,
    accounting: {
      timedEntryNotionalUsd: STRATEGY_NOTIONAL_USD,
      qualityObservationNotionalUsd: 0,
      rule: 'Only strategy_role=timed_entry is treated as a hypothetical purchased position. Quality observations measure coin selection before entry timing and must not be counted as portfolio P&L.',
      legacyReportWarning: 'Older aggregate paper-call totals can mix research observations with timed entries; use this strategyLifecycle section for actual strategy accounting.',
    },
    strategyDefinition: {
      qualitySelection: 'First decide whether the coin is worth further consideration using safety gates, score, grade, setup lane, flow, ownership, social, and smart-wallet evidence.',
      entryTiming: 'Only create a timed $100 paper position after conviction hold, trade evidence, buyer persistence, anti-chase cooling, source eligibility, model allowance, and final revalidation against the quality-selection price, liquidity, retention, and price continuity.',
      exitTiming: 'Protect the position with 3x/−50% hard boundaries, profit-locking trailing floors, emergency insider/liquidity exits, multi-signal deterioration exits, and a 24-hour time exit.',
      adaptiveExitPolicy: ADAPTIVE_EXIT_POLICY,
    },
    summary: {
      ...summary,
      qualityToTimedEntryConversionPct: quality ? Number((entries / quality * 100).toFixed(1)) : null,
      timedEntry3xPct: resolved ? Number((reached3x / resolved * 100).toFixed(1)) : null,
    },
    performanceByRole: roleRows,
    entryTimingAnalysis: {
      summary: pairSummaryRows[0] || {},
      pairedRecords: pairRows,
      qualityCandidatesWithoutTimedEntry: unconvertedRows,
      waitAndSkipReasonCounts: waitRows,
    },
    exitAnalysis: {
      reasonPerformance: exitRows,
      openTimedEntries: openRows,
    },
    decisionLedger: {
      storedInWindow: totalDecisions,
      included: decisionRows.length,
      truncated: decisionRows.length < totalDecisions,
      rows: decisionRows,
      note: 'Market-path snapshots remain in the main trade ledger. This ledger stores explicit quality, entry-wait, buy, hold, and sell decisions with reasons and metrics.',
    },
    dataCompleteness: completenessRows[0] || {},
    runtime: {
      strategyLifecycle: strategyLifecycleDiag(),
      entryRevalidation: entryRevalidationDiag(),
    },
    queryErrors: errors,
    interpretationRules: [
      'A quality observation means the bot selected a coin for study; it is not a buy.',
      'A timed entry means every entry-timing gate and final quality revalidation passed before a hypothetical $100 position opened.',
      'parent_observation_id links the actual timed entry to the earlier quality-selection observation.',
      'Every final strategy exit stores its reason code, human-readable reasons, deterioration signals, metrics, notional, and realized hypothetical P&L.',
      'Entry wait/skip decisions explain why a selected coin was not bought immediately.',
      'The policy is evidence-generating and advisory; it does not sign or broadcast transactions.',
    ],
  };
}
