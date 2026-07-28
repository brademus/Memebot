import { pool } from '../db';
import { pumpfunStreamDiag } from '../ingest/pumpfun';
import { strategyExtremaReconcilerDiag } from '../paper/strategy-extrema-reconciler';
import {
  EXIT_POLICY_VERSION,
  ensureStrategyPolicyEpoch,
  strategyPolicyEpochDiag,
} from '../paper/strategy-policy-epoch';
import {
  ADAPTIVE_EXIT_POLICY,
  DeteriorationFamily,
  deteriorationFamiliesFromSignals,
  STRATEGY_NOTIONAL_USD,
  STRATEGY_VERSION,
} from '../paper/strategy-policy';

interface PnlRow extends Record<string, any> {
  pnl_usd: number;
}

interface ExitAuditRow {
  tradeId: number;
  ca: string;
  symbol: string | null;
  exitAt: string | null;
  exitReason: string | null;
  finalMultiple: number | null;
  rawSignalCount: number;
  rawSignals: string[];
  independentFamilyCount: number;
  independentFamilies: DeteriorationFamily[];
  meetsCurrentIndependentFamilyRule: boolean;
}

const finite = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const stringArray = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {}
  }
  return [];
};

const guardDiag = () => {
  try {
    const reader = (globalThis as any).__pumpPortalGuardDiag;
    return typeof reader === 'function' ? reader() : { available: false, reason: 'preload_guard_diag_unavailable' };
  } catch (error) {
    return { available: false, reason: 'preload_guard_diag_failed', error: (error as Error).message };
  }
};

export async function buildStrategyIntegrityReport(days = 1) {
  const boundedDays = Math.max(1, Math.min(30, Math.floor(days) || 1));
  if (!pool) return { available: false, reason: 'database_unavailable' };
  const requestedWindowStart = new Date(Date.now() - boundedDays * 86_400_000).toISOString();
  let policyEpochAt: string;
  try {
    policyEpochAt = await ensureStrategyPolicyEpoch();
  } catch (error) {
    return { available: false, reason: 'strategy_policy_epoch_unavailable', error: (error as Error).message };
  }
  const cohortStart = new Date(Math.max(Date.parse(requestedWindowStart), Date.parse(policyEpochAt))).toISOString();
  const errors: string[] = [];
  const query = async (name: string, text: string, values: unknown[] = []): Promise<any[]> => {
    try {
      return (await pool!.query({ text, values, query_timeout: 12_000 } as any)).rows;
    } catch (error) {
      errors.push(`${name}: ${(error as Error).message}`);
      return [];
    }
  };

  const [accountingRows, quoteRows, coverageRows, concentrationSummaryRows,
    concentrationRows, exitRows] = await Promise.all([
    query('strategy integrity accounting', `SELECT
      COUNT(*)::int AS timed_entries,
      COUNT(*) FILTER (WHERE closed)::int AS closed,
      COUNT(*) FILTER (WHERE NOT closed)::int AS open,
      COUNT(*) FILTER (WHERE execution_eligible)::int AS entry_execution_eligible,
      COUNT(*) FILTER (WHERE transaction_built)::int AS entry_transaction_built,
      COUNT(*) FILTER (WHERE simulation_ok)::int AS entry_simulation_ok,
      COUNT(*) FILTER (WHERE exit_transaction_built)::int AS exit_transaction_built,
      COUNT(*) FILTER (WHERE exit_simulation_ok)::int AS exit_simulation_ok,
      COUNT(*) FILTER (WHERE closed AND exit_reason IS DISTINCT FROM 'tracking_lost')::int AS market_mark_resolved,
      ROUND(COALESCE(SUM(COALESCE(realized_pnl_usd,(final_multiple-1)*notional_usd))
        FILTER (WHERE closed AND exit_reason IS DISTINCT FROM 'tracking_lost'),0)::numeric,2) AS market_mark_pnl_usd,
      COUNT(*) FILTER (WHERE closed AND exit_reason IS DISTINCT FROM 'tracking_lost'
        AND execution_eligible AND transaction_built AND simulation_ok
        AND exit_transaction_built AND exit_simulation_ok
        AND position_usd>0 AND exit_quoted_usd IS NOT NULL)::int AS execution_proven_resolved,
      ROUND(COALESCE(SUM(exit_quoted_usd-position_usd)
        FILTER (WHERE closed AND exit_reason IS DISTINCT FROM 'tracking_lost'
          AND execution_eligible AND transaction_built AND simulation_ok
          AND exit_transaction_built AND exit_simulation_ok
          AND position_usd>0 AND exit_quoted_usd IS NOT NULL),0)::numeric,2) AS execution_proven_pnl_usd
      FROM paper_trades WHERE strategy_version=$1 AND strategy_role='timed_entry'
        AND entry_at>=$2::timestamptz`, [STRATEGY_VERSION, cohortStart]),
    query('strategy integrity quote status', `SELECT COALESCE(quote_status,'unknown') AS quote_status,
      COUNT(*)::int AS entries,COUNT(*) FILTER (WHERE closed)::int AS closed,
      COUNT(*) FILTER (WHERE closed AND exit_reason IS DISTINCT FROM 'tracking_lost')::int AS resolved,
      COUNT(*) FILTER (WHERE execution_eligible)::int AS entry_execution_eligible,
      COUNT(*) FILTER (WHERE transaction_built)::int AS entry_transaction_built,
      COUNT(*) FILTER (WHERE simulation_ok)::int AS entry_simulation_ok,
      COUNT(*) FILTER (WHERE exit_transaction_built)::int AS exit_transaction_built,
      COUNT(*) FILTER (WHERE exit_simulation_ok)::int AS exit_simulation_ok,
      COUNT(*) FILTER (WHERE closed AND exit_reason IS DISTINCT FROM 'tracking_lost'
        AND execution_eligible AND transaction_built AND simulation_ok
        AND exit_transaction_built AND exit_simulation_ok
        AND position_usd>0 AND exit_quoted_usd IS NOT NULL)::int AS execution_proven_resolved,
      ROUND((AVG(final_multiple) FILTER (WHERE closed AND exit_reason IS DISTINCT FROM 'tracking_lost'))::numeric,3) AS avg_multiple,
      ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY final_multiple)
        FILTER (WHERE closed AND exit_reason IS DISTINCT FROM 'tracking_lost'))::numeric,3) AS median_multiple,
      ROUND(COALESCE(SUM(COALESCE(realized_pnl_usd,(final_multiple-1)*notional_usd))
        FILTER (WHERE closed AND exit_reason IS DISTINCT FROM 'tracking_lost'),0)::numeric,2) AS market_mark_pnl_usd,
      ROUND(COALESCE(SUM(exit_quoted_usd-position_usd)
        FILTER (WHERE closed AND exit_reason IS DISTINCT FROM 'tracking_lost'
          AND execution_eligible AND transaction_built AND simulation_ok
          AND exit_transaction_built AND exit_simulation_ok
          AND position_usd>0 AND exit_quoted_usd IS NOT NULL),0)::numeric,2) AS execution_proven_pnl_usd
      FROM paper_trades WHERE strategy_version=$1 AND strategy_role='timed_entry'
        AND entry_at>=$2::timestamptz GROUP BY quote_status ORDER BY entries DESC`, [STRATEGY_VERSION, cohortStart]),
    query('strategy integrity coverage', `SELECT COUNT(*)::int AS timed_entries,
      COUNT(*) FILTER (WHERE exact_trade_events_at_entry>0)::int AS with_exact_trade_events_at_entry,
      COUNT(*) FILTER (WHERE coverage_snapshot#>>'{walletIdentities}'='true')::int AS with_wallet_identities,
      COUNT(*) FILTER (WHERE coverage_snapshot#>>'{tradeAmounts}'='true')::int AS with_trade_amounts,
      COUNT(*) FILTER (WHERE jsonb_typeof(token_snapshot#>'{safety,bundle}') IS DISTINCT FROM 'null'
        AND token_snapshot#>'{safety,bundle}' IS NOT NULL)::int AS with_bundle_measurement,
      COUNT(*) FILTER (WHERE token_snapshot#>>'{safety,entityGraph,complete}'='true')::int AS with_complete_entity_graph,
      COUNT(*) FILTER (WHERE coverage_snapshot#>>'{aggregateFlow}'='true')::int AS with_aggregate_flow,
      COUNT(*) FILTER (WHERE trigger_snapshot#>>'{revalidationReady}'='true')::int AS with_final_entry_revalidation
      FROM paper_trades WHERE strategy_version=$1 AND strategy_role='timed_entry'
        AND entry_at>=$2::timestamptz`, [STRATEGY_VERSION, cohortStart]),
    query('strategy integrity pnl concentration summary', `WITH resolved AS (
        SELECT COALESCE(realized_pnl_usd,(final_multiple-1)*notional_usd)::numeric AS pnl_usd
        FROM paper_trades WHERE strategy_version=$1 AND strategy_role='timed_entry'
          AND entry_at>=$2::timestamptz AND closed AND exit_reason IS DISTINCT FROM 'tracking_lost'
      ), ranked AS (
        SELECT pnl_usd,ROW_NUMBER() OVER (ORDER BY pnl_usd DESC NULLS LAST) AS rn FROM resolved
      ) SELECT COUNT(*)::int AS resolved,
        ROUND(COALESCE(SUM(pnl_usd),0),2) AS total_market_mark_pnl_usd,
        ROUND(COALESCE(MAX(pnl_usd),0),2) AS largest_winner_pnl_usd,
        ROUND(COALESCE(SUM(pnl_usd) FILTER (WHERE rn<=2),0),2) AS top_two_pnl_usd
      FROM ranked`, [STRATEGY_VERSION, cohortStart]),
    query('strategy integrity pnl concentration detail', `SELECT id,ca,symbol,entry_at,exit_at,quote_status,
      execution_eligible,transaction_built,simulation_ok,exit_transaction_built,exit_simulation_ok,
      position_usd,exit_quoted_usd,final_multiple,
      COALESCE(realized_pnl_usd,(final_multiple-1)*notional_usd) AS pnl_usd
      FROM paper_trades WHERE strategy_version=$1 AND strategy_role='timed_entry'
        AND entry_at>=$2::timestamptz AND closed AND exit_reason IS DISTINCT FROM 'tracking_lost'
      ORDER BY pnl_usd DESC NULLS LAST LIMIT 500`, [STRATEGY_VERSION, cohortStart]),
    query('strategy integrity exit audit', `SELECT id,ca,symbol,exit_at,exit_reason,final_multiple,
      exit_decision->'deteriorationSignals' AS deterioration_signals
      FROM paper_trades WHERE strategy_version=$1 AND strategy_role='timed_entry'
        AND entry_at>=$2::timestamptz AND closed
      ORDER BY exit_at,id LIMIT 5000`, [STRATEGY_VERSION, cohortStart]),
  ]);

  const accounting: any = accountingRows[0] || {};
  const coverage: any = coverageRows[0] || {};
  const concentration: any = concentrationSummaryRows[0] || {};
  const closedPnl: PnlRow[] = concentrationRows.map((row: any) => ({
    ...row,
    pnl_usd: finite(row.pnl_usd) || 0,
  }));
  const totalMarkPnl = Number(concentration.total_market_mark_pnl_usd || 0);
  const largestPnl = Number(concentration.largest_winner_pnl_usd || 0);
  const topTwoPnl = Number(concentration.top_two_pnl_usd || 0);
  const largest = closedPnl[0] || null;
  const marketMarkResolved = Number(accounting.market_mark_resolved || 0);
  const timedEntries = Number(accounting.timed_entries || 0);

  const auditedExits: ExitAuditRow[] = exitRows.map((row: any) => {
    const signals = stringArray(row.deterioration_signals);
    const families = deteriorationFamiliesFromSignals(signals);
    const multiple = finite(row.final_multiple);
    const meetsFamilyRule = families.length >= ADAPTIVE_EXIT_POLICY.deteriorationFamiliesToExit
      || (families.length >= 2 && multiple !== null && (multiple >= 1.05 || multiple <= 0.85));
    return {
      tradeId: Number(row.id), ca: String(row.ca), symbol: row.symbol ? String(row.symbol) : null,
      exitAt: row.exit_at ? String(row.exit_at) : null, exitReason: row.exit_reason ? String(row.exit_reason) : null,
      finalMultiple: multiple, rawSignalCount: signals.length, rawSignals: signals,
      independentFamilyCount: families.length, independentFamilies: families,
      meetsCurrentIndependentFamilyRule: meetsFamilyRule,
    };
  });
  const multiSignal = auditedExits.filter((row: ExitAuditRow) =>
    row.exitReason === 'strategy_multi_signal_deterioration_exit');

  const warnings: string[] = [];
  if (Number(accounting.execution_proven_resolved || 0) === 0)
    warnings.push('No closed timed entry has complete entry and exit transaction/simulation evidence; no P&L is execution-proven.');
  if (largest && totalMarkPnl > 0 && largestPnl > totalMarkPnl)
    warnings.push('The largest winner exceeds total market-mark P&L, so the remaining closed sample is net negative.');
  if (timedEntries && Number(coverage.with_wallet_identities || 0) / timedEntries < 0.5)
    warnings.push('Wallet-identity coverage is below 50%; buyer-retention and smart-wallet evidence are incomplete.');
  const pumpfun = pumpfunStreamDiag();
  if (pumpfun.effectiveMode !== 'full')
    warnings.push(`PumpPortal exact token-trade mode is ${pumpfun.effectiveMode}; aggregate market marks are not equivalent to trade-by-trade execution evidence.`);

  return {
    available: true,
    reportType: 'strategy_integrity_and_execution_honesty',
    strategyVersion: STRATEGY_VERSION,
    exitPolicyVersion: EXIT_POLICY_VERSION,
    requestedWindowStart,
    policyEpochAt,
    cohortStart,
    windowDaysRequested: boundedDays,
    cohortRule: 'Only timed entries opened at or after cohortStart are included. Pre-change trades remain in strategyLifecycle and historical evidence but cannot contaminate this policy headline.',
    accountingDefinitions: {
      marketMarkResearch: 'All timed-entry intents marked and exited from observed market prices. This measures signal behavior but does not prove the hypothetical order was routable or fillable.',
      executionProven: 'A closed timed entry is counted only when both entry and exit were eligible, transactions were built, simulations succeeded, and simulated exit proceeds are recorded. This remains shadow-only and does not broadcast.',
      executionProvenPnlFormula: 'exit_quoted_usd - position_usd; observed market-mark P&L is never substituted.',
      notionalUsdPerTimedEntry: STRATEGY_NOTIONAL_USD,
    },
    accounting: {
      ...accounting,
      marketMarkProfitable: Number(accounting.market_mark_pnl_usd || 0) > 0,
      executionProvenSampleReady: Number(accounting.execution_proven_resolved || 0) > 0,
      headlineRule: 'Never describe market_mark_pnl_usd as executable or realized trading profit. Execution claims must use execution_proven_resolved and execution_proven_pnl_usd.',
    },
    performanceByQuoteStatus: quoteRows,
    evidenceCoverage: {
      ...coverage,
      exactTradeEntryCoveragePct: timedEntries ? Number((100 * Number(coverage.with_exact_trade_events_at_entry || 0) / timedEntries).toFixed(1)) : null,
      walletIdentityCoveragePct: timedEntries ? Number((100 * Number(coverage.with_wallet_identities || 0) / timedEntries).toFixed(1)) : null,
      bundleCoveragePct: timedEntries ? Number((100 * Number(coverage.with_bundle_measurement || 0) / timedEntries).toFixed(1)) : null,
      completeEntityGraphPct: timedEntries ? Number((100 * Number(coverage.with_complete_entity_graph || 0) / timedEntries).toFixed(1)) : null,
      finalEntryRevalidationPct: timedEntries ? Number((100 * Number(coverage.with_final_entry_revalidation || 0) / timedEntries).toFixed(1)) : null,
    },
    pnlRobustness: {
      resolvedTimedEntries: marketMarkResolved,
      totalMarketMarkPnlUsd: totalMarkPnl,
      largestWinner: largest,
      largestWinnerPnlUsd: largestPnl,
      marketMarkPnlExcludingLargestWinnerUsd: Number((totalMarkPnl - largestPnl).toFixed(2)),
      marketMarkPnlExcludingTopTwoUsd: Number((totalMarkPnl - topTwoPnl).toFixed(2)),
      largestWinnerShareOfPositiveHeadlinePct: totalMarkPnl > 0
        ? Number((100 * largestPnl / totalMarkPnl).toFixed(1)) : null,
      closedRowsIncluded: closedPnl.length,
      closedRowsTruncated: marketMarkResolved > closedPnl.length,
      closedRows: closedPnl,
    },
    exitIndependenceAudit: {
      policy: 'Correlated model outputs count as one model family. DYING/DEAD is not counted again when direct score, flow, or momentum evidence already explains the state.',
      multiSignalExits: multiSignal.length,
      exitsWithFewerThanThreeIndependentFamilies: multiSignal.filter((row: ExitAuditRow) =>
        row.independentFamilyCount < 3).length,
      exitsMeetingCurrentIndependentFamilyRule: multiSignal.filter((row: ExitAuditRow) =>
        row.meetsCurrentIndependentFamilyRule).length,
      rows: auditedExits,
    },
    runtime: {
      strategyPolicyEpoch: strategyPolicyEpochDiag(),
      pumpPortalApplication: pumpfun,
      pumpPortalSubscriptionGuard: guardDiag(),
      strategyExtremaReconciler: strategyExtremaReconcilerDiag(),
    },
    warnings,
    queryErrors: errors,
    interpretationRules: [
      'Positive market-mark P&L is research evidence, not proof that a trade could be entered and exited at the recorded prices.',
      'Both entry-side and exit-side simulation evidence are required for execution-proven classification.',
      'Quote status and execution evidence must be evaluated before judging strategy profitability.',
      'P&L concentration aggregates the full cohort; only the returned detail rows are capped.',
      'The exit audit distinguishes raw correlated conditions from independent evidence families.',
      'No signing, custody, or transaction broadcasting is performed.',
    ],
  };
}
