import { pool } from '../db';
import { pumpfunStreamDiag } from '../ingest/pumpfun';
import { strategyExtremaReconcilerDiag } from '../paper/strategy-extrema-reconciler';
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
  const windowStart = new Date(Date.now() - boundedDays * 86_400_000).toISOString();
  const errors: string[] = [];
  const query = async (name: string, text: string, values: unknown[] = []): Promise<any[]> => {
    try {
      return (await pool!.query({ text, values, query_timeout: 12_000 } as any)).rows;
    } catch (error) {
      errors.push(`${name}: ${(error as Error).message}`);
      return [];
    }
  };

  const [accountingRows, quoteRows, coverageRows, concentrationRows, exitRows] = await Promise.all([
    query('strategy integrity accounting', `SELECT
      COUNT(*)::int AS timed_entries,
      COUNT(*) FILTER (WHERE closed)::int AS closed,
      COUNT(*) FILTER (WHERE NOT closed)::int AS open,
      COUNT(*) FILTER (WHERE execution_eligible)::int AS execution_eligible,
      COUNT(*) FILTER (WHERE transaction_built)::int AS transaction_built,
      COUNT(*) FILTER (WHERE simulation_ok)::int AS simulation_ok,
      COUNT(*) FILTER (WHERE closed AND exit_reason IS DISTINCT FROM 'tracking_lost')::int AS market_mark_resolved,
      ROUND(COALESCE(SUM(COALESCE(realized_pnl_usd,(final_multiple-1)*notional_usd))
        FILTER (WHERE closed AND exit_reason IS DISTINCT FROM 'tracking_lost'),0)::numeric,2) AS market_mark_pnl_usd,
      COUNT(*) FILTER (WHERE closed AND exit_reason IS DISTINCT FROM 'tracking_lost'
        AND execution_eligible AND transaction_built AND simulation_ok)::int AS execution_proven_resolved,
      ROUND(COALESCE(SUM(COALESCE(realized_pnl_usd,(final_multiple-1)*notional_usd))
        FILTER (WHERE closed AND exit_reason IS DISTINCT FROM 'tracking_lost'
          AND execution_eligible AND transaction_built AND simulation_ok),0)::numeric,2) AS execution_proven_pnl_usd
      FROM paper_trades WHERE strategy_version=$1 AND strategy_role='timed_entry'
        AND entry_at>=$2::timestamptz`, [STRATEGY_VERSION, windowStart]),
    query('strategy integrity quote status', `SELECT COALESCE(quote_status,'unknown') AS quote_status,
      COUNT(*)::int AS entries,COUNT(*) FILTER (WHERE closed)::int AS closed,
      COUNT(*) FILTER (WHERE closed AND exit_reason IS DISTINCT FROM 'tracking_lost')::int AS resolved,
      COUNT(*) FILTER (WHERE execution_eligible)::int AS execution_eligible,
      COUNT(*) FILTER (WHERE transaction_built)::int AS transaction_built,
      COUNT(*) FILTER (WHERE simulation_ok)::int AS simulation_ok,
      ROUND((AVG(final_multiple) FILTER (WHERE closed AND exit_reason IS DISTINCT FROM 'tracking_lost'))::numeric,3) AS avg_multiple,
      ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY final_multiple)
        FILTER (WHERE closed AND exit_reason IS DISTINCT FROM 'tracking_lost'))::numeric,3) AS median_multiple,
      ROUND(COALESCE(SUM(COALESCE(realized_pnl_usd,(final_multiple-1)*notional_usd))
        FILTER (WHERE closed AND exit_reason IS DISTINCT FROM 'tracking_lost'),0)::numeric,2) AS market_mark_pnl_usd
      FROM paper_trades WHERE strategy_version=$1 AND strategy_role='timed_entry'
        AND entry_at>=$2::timestamptz GROUP BY quote_status ORDER BY entries DESC`, [STRATEGY_VERSION, windowStart]),
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
        AND entry_at>=$2::timestamptz`, [STRATEGY_VERSION, windowStart]),
    query('strategy integrity pnl concentration', `SELECT id,ca,symbol,entry_at,exit_at,quote_status,
      execution_eligible,transaction_built,simulation_ok,final_multiple,
      COALESCE(realized_pnl_usd,(final_multiple-1)*notional_usd) AS pnl_usd
      FROM paper_trades WHERE strategy_version=$1 AND strategy_role='timed_entry'
        AND entry_at>=$2::timestamptz AND closed AND exit_reason IS DISTINCT FROM 'tracking_lost'
      ORDER BY pnl_usd DESC NULLS LAST LIMIT 5000`, [STRATEGY_VERSION, windowStart]),
    query('strategy integrity exit audit', `SELECT id,ca,symbol,exit_at,exit_reason,final_multiple,
      exit_decision->'deteriorationSignals' AS deterioration_signals
      FROM paper_trades WHERE strategy_version=$1 AND strategy_role='timed_entry'
        AND entry_at>=$2::timestamptz AND closed
      ORDER BY exit_at,id LIMIT 5000`, [STRATEGY_VERSION, windowStart]),
  ]);

  const accounting: any = accountingRows[0] || {};
  const coverage: any = coverageRows[0] || {};
  const closedPnl: PnlRow[] = concentrationRows.map((row: any) => ({
    ...row,
    pnl_usd: finite(row.pnl_usd) || 0,
  }));
  const totalMarkPnl = closedPnl.reduce((sum: number, row: PnlRow) => sum + row.pnl_usd, 0);
  const largest = closedPnl[0] || null;
  const topTwo = closedPnl.slice(0, 2).reduce((sum: number, row: PnlRow) => sum + row.pnl_usd, 0);
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
  const legacyMultiSignal = auditedExits.filter((row: ExitAuditRow) =>
    row.exitReason === 'strategy_multi_signal_deterioration_exit');

  const warnings: string[] = [];
  if (Number(accounting.execution_proven_resolved || 0) === 0)
    warnings.push('No closed timed entry has entry eligibility, a built transaction, and a successful simulation; no P&L is execution-proven.');
  if (largest && totalMarkPnl > 0 && largest.pnl_usd > totalMarkPnl)
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
    windowStart,
    windowDaysRequested: boundedDays,
    accountingDefinitions: {
      marketMarkResearch: 'All timed-entry intents marked and exited from observed market prices. This measures signal behavior but does not prove the hypothetical order was routable or fillable.',
      executionProven: 'A closed timed entry is counted only when its entry was execution-eligible, a transaction was built, and simulation succeeded. This remains shadow-only and does not broadcast.',
      notionalUsdPerTimedEntry: STRATEGY_NOTIONAL_USD,
    },
    accounting: {
      ...accounting,
      marketMarkProfitable: Number(accounting.market_mark_pnl_usd || 0) > 0,
      executionProvenSampleReady: Number(accounting.execution_proven_resolved || 0) > 0,
      headlineRule: 'Never describe market_mark_pnl_usd as executable or realized trading profit unless execution_proven_resolved is sufficient and execution_proven_pnl_usd is separately reported.',
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
      totalMarketMarkPnlUsd: Number(totalMarkPnl.toFixed(2)),
      largestWinner: largest,
      marketMarkPnlExcludingLargestWinnerUsd: Number((totalMarkPnl - Number(largest?.pnl_usd || 0)).toFixed(2)),
      marketMarkPnlExcludingTopTwoUsd: Number((totalMarkPnl - topTwo).toFixed(2)),
      largestWinnerShareOfPositiveHeadlinePct: totalMarkPnl > 0 && largest
        ? Number((100 * largest.pnl_usd / totalMarkPnl).toFixed(1)) : null,
      closedRows: closedPnl,
    },
    exitIndependenceAudit: {
      policy: 'Correlated model outputs count as one model family. DYING/DEAD is not counted again when direct score, flow, or momentum evidence already explains the state.',
      legacyMultiSignalExits: legacyMultiSignal.length,
      legacyExitsWithFewerThanThreeIndependentFamilies: legacyMultiSignal.filter((row: ExitAuditRow) =>
        row.independentFamilyCount < 3).length,
      legacyExitsMeetingCurrentIndependentFamilyRule: legacyMultiSignal.filter((row: ExitAuditRow) =>
        row.meetsCurrentIndependentFamilyRule).length,
      rows: auditedExits,
    },
    runtime: {
      pumpPortalApplication: pumpfun,
      pumpPortalSubscriptionGuard: guardDiag(),
      strategyExtremaReconciler: strategyExtremaReconcilerDiag(),
    },
    warnings,
    queryErrors: errors,
    interpretationRules: [
      'Positive market-mark P&L is research evidence, not proof that a trade could be entered and exited at the recorded prices.',
      'Quote status and execution evidence must be evaluated before judging strategy profitability.',
      'P&L concentration is reported because one outlier winner can conceal a negative remainder of the sample.',
      'The exit audit distinguishes raw correlated conditions from independent evidence families.',
      'No signing, custody, or transaction broadcasting is performed.',
    ],
  };
}
