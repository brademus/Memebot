import { pool } from '../db';
import { quoteCategory, quotePhase } from '../paper/quote-status';

const number = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : 0;

export async function buildCleanEvidence(days = 7) {
  const boundedDays = Math.max(1, Math.min(30, Math.floor(days) || 7));
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

  const epochRows = await query('epoch',
    `SELECT started_at FROM evidence_epochs WHERE name='post_infrastructure_repair_v1' LIMIT 1`);
  const epochAt = epochRows[0]?.started_at ? new Date(epochRows[0].started_at).toISOString() : null;
  if (!epochAt) return { available: false, reason: 'clean_evidence_epoch_missing', errors };

  const windowStart = new Date(Math.max(Date.now() - boundedDays * 86_400_000, Date.parse(epochAt))).toISOString();
  const [summaryRows, bySignal, bySource, byScoreBand, quoteRows, decisionRows] = await Promise.all([
    query('summary', `SELECT
      COUNT(*)::int AS calls,
      COUNT(*) FILTER (WHERE NOT closed)::int AS open,
      COUNT(*) FILTER (WHERE closed AND exit_reason IS DISTINCT FROM 'tracking_lost')::int AS resolved,
      COUNT(*) FILTER (WHERE closed AND exit_reason='tracking_lost')::int AS tracking_lost,
      COUNT(*) FILTER (WHERE execution_eligible)::int AS executable,
      COUNT(*) FILTER (WHERE transaction_built)::int AS transaction_built,
      COUNT(*) FILTER (WHERE simulation_ok)::int AS simulation_ok,
      COUNT(*) FILTER (WHERE observed_target_hit_at IS NOT NULL)::int AS observed_3x,
      COUNT(*) FILTER (WHERE closed AND exit_reason IS DISTINCT FROM 'tracking_lost' AND final_multiple>=2)::int AS reached_2x,
      COUNT(*) FILTER (WHERE closed AND exit_reason IS DISTINCT FROM 'tracking_lost' AND final_multiple>=3)::int AS reached_3x,
      ROUND((AVG(final_multiple) FILTER (WHERE closed AND exit_reason IS DISTINCT FROM 'tracking_lost'))::numeric,3) AS avg_final_multiple,
      ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY final_multiple)
        FILTER (WHERE closed AND exit_reason IS DISTINCT FROM 'tracking_lost'))::numeric,3) AS median_final_multiple,
      ROUND((AVG(max_runup_pct) FILTER (WHERE closed AND exit_reason IS DISTINCT FROM 'tracking_lost'))::numeric,2) AS avg_max_runup_pct,
      ROUND((AVG(max_drawdown_pct) FILTER (WHERE closed AND exit_reason IS DISTINCT FROM 'tracking_lost'))::numeric,2) AS avg_max_drawdown_pct,
      MIN(entry_at) AS first_entry_at,MAX(entry_at) AS last_entry_at
      FROM paper_trades WHERE entry_at >= $1`, [windowStart]),
    query('by signal', `SELECT signal,model_version,COUNT(*)::int AS calls,
      COUNT(*) FILTER (WHERE closed AND exit_reason IS DISTINCT FROM 'tracking_lost')::int AS resolved,
      COUNT(*) FILTER (WHERE execution_eligible)::int AS executable,
      COUNT(*) FILTER (WHERE closed AND exit_reason IS DISTINCT FROM 'tracking_lost' AND final_multiple>=3)::int AS reached_3x,
      ROUND((AVG(final_multiple) FILTER (WHERE closed AND exit_reason IS DISTINCT FROM 'tracking_lost'))::numeric,3) AS avg_final_multiple,
      ROUND((AVG(max_runup_pct) FILTER (WHERE closed AND exit_reason IS DISTINCT FROM 'tracking_lost'))::numeric,2) AS avg_max_runup_pct,
      ROUND((AVG(max_drawdown_pct) FILTER (WHERE closed AND exit_reason IS DISTINCT FROM 'tracking_lost'))::numeric,2) AS avg_max_drawdown_pct
      FROM paper_trades WHERE entry_at >= $1 GROUP BY signal,model_version ORDER BY calls DESC`, [windowStart]),
    query('by source', `SELECT COALESCE(t.source,'unknown') AS source,COUNT(*)::int AS calls,
      COUNT(*) FILTER (WHERE p.closed AND p.exit_reason IS DISTINCT FROM 'tracking_lost')::int AS resolved,
      COUNT(*) FILTER (WHERE p.execution_eligible)::int AS executable,
      COUNT(*) FILTER (WHERE p.closed AND p.exit_reason IS DISTINCT FROM 'tracking_lost' AND p.final_multiple>=3)::int AS reached_3x,
      ROUND((AVG(p.final_multiple) FILTER (WHERE p.closed AND p.exit_reason IS DISTINCT FROM 'tracking_lost'))::numeric,3) AS avg_final_multiple,
      ROUND((AVG(p.max_runup_pct) FILTER (WHERE p.closed AND p.exit_reason IS DISTINCT FROM 'tracking_lost'))::numeric,2) AS avg_max_runup_pct,
      ROUND((AVG(p.max_drawdown_pct) FILTER (WHERE p.closed AND p.exit_reason IS DISTINCT FROM 'tracking_lost'))::numeric,2) AS avg_max_drawdown_pct
      FROM paper_trades p LEFT JOIN tokens t ON t.ca=p.ca WHERE p.entry_at >= $1
      GROUP BY COALESCE(t.source,'unknown') ORDER BY calls DESC`, [windowStart]),
    query('by score band', `SELECT
      CASE WHEN entry_score IS NULL THEN 'unknown'
           WHEN entry_score<40 THEN '<40'
           WHEN entry_score<50 THEN '40-49'
           WHEN entry_score<60 THEN '50-59'
           WHEN entry_score<70 THEN '60-69'
           WHEN entry_score<80 THEN '70-79' ELSE '80+' END AS score_band,
      COUNT(*)::int AS calls,
      COUNT(*) FILTER (WHERE closed AND exit_reason IS DISTINCT FROM 'tracking_lost')::int AS resolved,
      COUNT(*) FILTER (WHERE closed AND exit_reason IS DISTINCT FROM 'tracking_lost' AND final_multiple>=3)::int AS reached_3x,
      ROUND((AVG(final_multiple) FILTER (WHERE closed AND exit_reason IS DISTINCT FROM 'tracking_lost'))::numeric,3) AS avg_final_multiple,
      ROUND((AVG(max_runup_pct) FILTER (WHERE closed AND exit_reason IS DISTINCT FROM 'tracking_lost'))::numeric,2) AS avg_max_runup_pct,
      ROUND((AVG(max_drawdown_pct) FILTER (WHERE closed AND exit_reason IS DISTINCT FROM 'tracking_lost'))::numeric,2) AS avg_max_drawdown_pct
      FROM paper_trades WHERE entry_at >= $1 GROUP BY 1 ORDER BY MIN(entry_score) NULLS FIRST`, [windowStart]),
    query('quote status', `SELECT quote_status,quote_key_present,transaction_built,simulation_ok,COUNT(*)::int AS n,
      MIN(entry_at) AS first_at,MAX(entry_at) AS last_at
      FROM paper_trades WHERE entry_at >= $1
      GROUP BY quote_status,quote_key_present,transaction_built,simulation_ok ORDER BY n DESC`, [windowStart]),
    query('model decisions', `SELECT COUNT(*)::int AS decisions,
      COUNT(*) FILTER (WHERE allow)::int AS allowed,
      COUNT(*) FILTER (WHERE preliminary_pass)::int AS preliminary_passed,
      ROUND(AVG(target_before_stop_probability)::numeric,4) AS avg_target_probability,
      ROUND(AVG(downside_probability)::numeric,4) AS avg_downside_probability,
      ROUND(AVG(expected_value)::numeric,4) AS avg_expected_value,
      COUNT(*) FILTER (WHERE o.status='resolved')::int AS resolved_outcomes,
      COUNT(*) FILTER (WHERE o.first_event='target')::int AS target_first,
      COUNT(*) FILTER (WHERE o.first_event='stop')::int AS stop_first,
      COUNT(*) FILTER (WHERE o.tracking_gap)::int AS tracking_gaps
      FROM signal_decisions d LEFT JOIN signal_decision_outcomes o ON o.decision_id=d.id
      WHERE d.evaluated_at >= $1`, [windowStart]),
  ]);

  const summary = summaryRows[0] || {};
  const resolved = number(summary.resolved);
  const trackingLost = number(summary.tracking_lost);
  const decision = decisionRows[0] || {};
  const decisionResolved = number(decision.resolved_outcomes);
  return {
    available: true,
    evidenceEpochAt: epochAt,
    windowStart,
    windowDaysRequested: boundedDays,
    summary: {
      ...summary,
      trackingLostPct: resolved + trackingLost ? Math.round(trackingLost / (resolved + trackingLost) * 1000) / 10 : null,
      reached3xPct: resolved ? Math.round(number(summary.reached_3x) / resolved * 1000) / 10 : null,
      reached2xPct: resolved ? Math.round(number(summary.reached_2x) / resolved * 1000) / 10 : null,
    },
    bySignal,
    bySource,
    byScoreBand,
    quoteStatuses: quoteRows.map((row: any) => ({
      ...row,
      phase: quotePhase(row.quote_status, row.quote_key_present),
      category: quoteCategory(row.quote_status),
    })),
    modelDecisions: {
      ...decision,
      targetFirstPct: decisionResolved ? Math.round(number(decision.target_first) / decisionResolved * 1000) / 10 : null,
      stopFirstPct: decisionResolved ? Math.round(number(decision.stop_first) / decisionResolved * 1000) / 10 : null,
    },
    limitations: [
      'Lite mode uses aggregate Dexscreener flow and does not include paid per-wallet PumpPortal trade identities.',
      'Pre-graduation Pump.fun entries are research observations, not Jupiter execution failures.',
      'Only post-repair entries are included; historical infrastructure failures remain preserved elsewhere.',
    ],
    errors,
  };
}
