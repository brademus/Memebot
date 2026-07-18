import { pool } from '../db';

const NORMALIZED_STAKE_USD = 100;
const ALERT_SIGNALS = ['trigger', 'conviction'] as const;

type CallStatus = 'open' | 'win' | 'loss' | 'unresolved';

interface PaperCallRow {
  ca: string;
  symbol: string | null;
  signal: string;
  entry_at: string;
  entry_score: string | number | null;
  entry_price: string | number;
  peak_price: string | number | null;
  last_price: string | number | null;
  last_at: string | null;
  exit_price: string | number | null;
  exit_at: string | null;
  exit_reason: string | null;
  closed: boolean;
  execution_eligible: boolean;
  quote_status: string | null;
  target_hit_at: string | null;
  observed_target_hit_at: string | null;
  position_usd: string | number | null;
}

export interface DashboardCall {
  ca: string;
  symbol: string;
  signal: string;
  entryAt: string;
  entryScore: number | null;
  entryPrice: number;
  markPrice: number;
  markAt: string | null;
  peakMultiple: number;
  multiple: number;
  pnlPct: number;
  normalizedStakeUsd: number;
  normalizedPnlUsd: number;
  simulatedPositionUsd: number | null;
  simulatedPnlUsd: number | null;
  status: CallStatus;
  closed: boolean;
  exitAt: string | null;
  exitReason: string | null;
  executionEligible: boolean;
  quoteStatus: string | null;
  targetHit: boolean;
  observedTargetHit: boolean;
}

const numeric = (value: unknown, fallback = 0): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const round = (value: number, decimals = 2): number => {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

export function normalizeDashboardCall(row: PaperCallRow): DashboardCall {
  const entryPrice = Math.max(numeric(row.entry_price), Number.EPSILON);
  const markPrice = numeric(row.closed ? (row.exit_price ?? row.last_price) : row.last_price, entryPrice) || entryPrice;
  const peakPrice = Math.max(numeric(row.peak_price, entryPrice), entryPrice);
  const multiple = Math.max(0, markPrice / entryPrice);
  const pnlPct = (multiple - 1) * 100;
  const normalizedPnlUsd = NORMALIZED_STAKE_USD * (multiple - 1);
  const positionUsd = numeric(row.position_usd, 0);
  const unresolved = row.closed && row.exit_reason === 'tracking_lost';
  const status: CallStatus = !row.closed
    ? 'open'
    : unresolved
      ? 'unresolved'
      : multiple > 1
        ? 'win'
        : 'loss';

  return {
    ca: row.ca,
    symbol: row.symbol || '?',
    signal: row.signal,
    entryAt: row.entry_at,
    entryScore: row.entry_score == null ? null : numeric(row.entry_score),
    entryPrice,
    markPrice,
    markAt: row.closed ? row.exit_at : row.last_at,
    peakMultiple: round(peakPrice / entryPrice, 3),
    multiple: round(multiple, 3),
    pnlPct: round(pnlPct, 1),
    normalizedStakeUsd: NORMALIZED_STAKE_USD,
    normalizedPnlUsd: round(normalizedPnlUsd, 2),
    simulatedPositionUsd: positionUsd > 0 ? round(positionUsd, 2) : null,
    simulatedPnlUsd: positionUsd > 0 ? round(positionUsd * (multiple - 1), 2) : null,
    status,
    closed: row.closed,
    exitAt: row.exit_at,
    exitReason: row.exit_reason,
    executionEligible: row.execution_eligible,
    quoteStatus: row.quote_status,
    targetHit: !!row.target_hit_at,
    observedTargetHit: !!row.observed_target_hit_at,
  };
}

export async function buildCallsDashboard() {
  if (!pool) {
    return {
      normalizedStakeUsd: NORMALIZED_STAKE_USD,
      summary: emptySummary(),
      current: [],
      winners: [],
      losers: [],
      unresolved: [],
      note: 'Attach Postgres to track calls and results.',
    };
  }

  const result = await pool.query<PaperCallRow>(`
    WITH alert_calls AS (
      SELECT ca,symbol,signal,entry_at,entry_score,entry_price,peak_price,last_price,last_at,
             exit_price,exit_at,exit_reason,closed,execution_eligible,quote_status,target_hit_at,
             observed_target_hit_at,position_usd,
             ROW_NUMBER() OVER (
               PARTITION BY ca
               ORDER BY entry_at ASC,
                        CASE signal WHEN 'trigger' THEN 0 WHEN 'conviction' THEN 1 ELSE 2 END
             ) AS call_number
        FROM paper_trades
       WHERE signal = ANY($1::text[])
    )
    SELECT ca,symbol,signal,entry_at,entry_score,entry_price,peak_price,last_price,last_at,
           exit_price,exit_at,exit_reason,closed,execution_eligible,quote_status,target_hit_at,
           observed_target_hit_at,position_usd
      FROM alert_calls
     WHERE call_number = 1
     ORDER BY entry_at DESC
     LIMIT 1000`, [ALERT_SIGNALS]);

  const calls = result.rows.map(normalizeDashboardCall);
  const current = calls.filter(call => call.status === 'open');
  const winners = calls.filter(call => call.status === 'win');
  const losers = calls.filter(call => call.status === 'loss');
  const unresolved = calls.filter(call => call.status === 'unresolved');
  const resolved = [...winners, ...losers];

  const closedPnlUsd = resolved.reduce((sum, call) => sum + call.normalizedPnlUsd, 0);
  const openPnlUsd = current.reduce((sum, call) => sum + call.normalizedPnlUsd, 0);
  const closedCapitalUsd = resolved.length * NORMALIZED_STAKE_USD;
  const openCapitalUsd = current.length * NORMALIZED_STAKE_USD;

  return {
    normalizedStakeUsd: NORMALIZED_STAKE_USD,
    summary: {
      totalCalls: calls.length,
      currentCalls: current.length,
      resolvedCalls: resolved.length,
      wins: winners.length,
      losses: losers.length,
      unresolved: unresolved.length,
      winRatePct: resolved.length ? round((winners.length / resolved.length) * 100, 1) : null,
      closedPnlUsd: round(closedPnlUsd, 2),
      closedReturnPct: closedCapitalUsd ? round((closedPnlUsd / closedCapitalUsd) * 100, 1) : null,
      openPnlUsd: round(openPnlUsd, 2),
      openReturnPct: openCapitalUsd ? round((openPnlUsd / openCapitalUsd) * 100, 1) : null,
      normalizedCapitalDeployedUsd: closedCapitalUsd,
    },
    current,
    winners,
    losers,
    unresolved,
  };
}

function emptySummary() {
  return {
    totalCalls: 0,
    currentCalls: 0,
    resolvedCalls: 0,
    wins: 0,
    losses: 0,
    unresolved: 0,
    winRatePct: null,
    closedPnlUsd: 0,
    closedReturnPct: null,
    openPnlUsd: 0,
    openReturnPct: null,
    normalizedCapitalDeployedUsd: 0,
  };
}
