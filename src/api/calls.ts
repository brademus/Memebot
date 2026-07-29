import { pool } from '../db';
import { ensureStrategyPolicyEpoch } from '../paper/strategy-policy-epoch';
import { getBtcStatus } from '../btc/runtime';

const NORMALIZED_STAKE_USD = 100;
export const BUY_ALERT_SIGNAL = 'trigger' as const;

export type CallStatus = 'open' | 'win' | 'breakeven' | 'loss' | 'unresolved';
// A close within ±0.1% of entry is a controlled scratch (the deterioration exit's
// job), not a loss — counting scratches as losses buried the real hit rate.
const BREAKEVEN_BAND = 0.001;

export interface PaperCallRow {
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
      : multiple > 1 + BREAKEVEN_BAND
        ? 'win'
        : multiple < 1 - BREAKEVEN_BAND
          ? 'loss'
          : 'breakeven';

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
  const btc = await getBtcStatus();
  if (!pool) {
    return {
      normalizedStakeUsd: NORMALIZED_STAKE_USD,
      summary: emptySummary(),
      current: [],
      winners: [],
      losers: [],
      unresolved: [],
      note: 'Attach Postgres to track calls and results.',
      btc,
    };
  }

  // REAL WINS AND LOSSES ONLY (user-directed 2026-07-28): the board shows the
  // same honest cohort as the strategy reports — actual timed entries since the
  // clean-slate epoch. Research observations, model shadows, and every earlier
  // era (including the coverage-week wreckage) are excluded. The epoch comes
  // from the same evidence_epochs row the lifecycle report keys on, so this
  // board and the report can never disagree.
  let epochAt: string | null = null;
  try { epochAt = await ensureStrategyPolicyEpoch(); } catch { /* fail closed below */ }
  if (!epochAt) {
    // FAIL CLOSED (review finding): an unverifiable epoch must never silently
    // widen the board to contaminated all-time history.
    return {
      normalizedStakeUsd: NORMALIZED_STAKE_USD,
      summary: emptySummary(),
      cohort: 'unavailable_evidence_epoch_unverified',
      epochAt: null,
      current: [], winners: [], breakevens: [], losers: [], unresolved: [],
      note: 'Cohort unavailable: the evidence epoch could not be verified. Showing nothing rather than mixed-era history.',
      btc,
    };
  }
  const result = await pool.query<PaperCallRow>(`
    SELECT ca,symbol,signal,entry_at,entry_score,entry_price,peak_price,last_price,last_at,
           exit_price,exit_at,exit_reason,closed,execution_eligible,quote_status,target_hit_at,
           observed_target_hit_at,position_usd
      FROM paper_trades
     WHERE signal=$1 AND strategy_role='timed_entry'
       AND entry_at >= $2::timestamptz
     ORDER BY entry_at DESC
     LIMIT 1000`, [BUY_ALERT_SIGNAL, epochAt]);

  const calls = result.rows.map(normalizeDashboardCall);
  const current = calls.filter(call => call.status === 'open');
  const winners = calls.filter(call => call.status === 'win');
  const breakevens = calls.filter(call => call.status === 'breakeven');
  const losers = calls.filter(call => call.status === 'loss');
  const unresolved = calls.filter(call => call.status === 'unresolved');
  const resolved = [...winners, ...breakevens, ...losers];

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
      breakeven: breakevens.length,
      losses: losers.length,
      unresolved: unresolved.length,
      // decided outcomes only: scratches are neither wins nor losses
      winRatePct: (winners.length + losers.length) ? round((winners.length / (winners.length + losers.length)) * 100, 1) : null,
      closedPnlUsd: round(closedPnlUsd, 2),
      closedReturnPct: closedCapitalUsd ? round((closedPnlUsd / closedCapitalUsd) * 100, 1) : null,
      openPnlUsd: round(openPnlUsd, 2),
      openReturnPct: openCapitalUsd ? round((openPnlUsd / openCapitalUsd) * 100, 1) : null,
      normalizedCapitalDeployedUsd: closedCapitalUsd,
    },
    cohort: 'timed_entries_since_clean_epoch',
    epochAt,
    current,
    winners,
    breakevens,
    losers,
    unresolved,
    btc,
  };
}

function emptySummary() {
  return {
    totalCalls: 0,
    currentCalls: 0,
    resolvedCalls: 0,
    wins: 0,
    breakeven: 0,
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
