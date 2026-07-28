import { cfg } from '../config';
import { pool } from '../db';
import { TokenRecord } from '../types';
import { STRATEGY_VERSION } from '../paper/strategy-policy';

const REFRESH_MS = 2_000;
const MAX_REFERENCE_AGE_MS = 48 * 60 * 60_000;

interface QualityReference {
  paperTradeId: number;
  ca: string;
  signal: string;
  selectedAt: number;
  selectedPrice: number;
}

export interface EntryRevalidationAssessment {
  revalidationReady: boolean;
  revalidationBlockers: string[];
  revalidationReasons: string[];
  qualityReference: QualityReference | null;
  selectionPremiumPct: number | null;
  liquidityReady: boolean;
  retentionReady: boolean;
  marketContinuityReady: boolean;
  qualityTooLate: boolean;
  earlyRetention: number | null;
  movedFromFirstScorePct: number | null;
}

const references = new Map<string, QualityReference>();
let started = false;
let refreshing = false;
const diag = {
  refreshes: 0,
  loaded: 0,
  lastRefreshAt: null as string | null,
  lastSuccessAt: null as string | null,
  lastError: null as string | null,
};

export const entryRevalidationDiag = () => ({
  enabled: !!pool,
  refreshIntervalSeconds: REFRESH_MS / 1000,
  references: references.size,
  ...diag,
});

const finite = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

async function refreshQualityReferences() {
  if (!pool || refreshing) return;
  refreshing = true;
  diag.refreshes++;
  diag.lastRefreshAt = new Date().toISOString();
  try {
    const result = await pool.query(`SELECT DISTINCT ON (ca)
        id,ca,signal,entry_at,entry_price
      FROM paper_trades
      WHERE strategy_role='quality_observation' AND strategy_version=$1
        AND entry_at>now()-interval '48 hours'
      ORDER BY ca,entry_at DESC`, [STRATEGY_VERSION]);
    const next = new Map<string, QualityReference>();
    for (const row of result.rows) {
      const selectedPrice = Number(row.entry_price);
      const selectedAt = new Date(row.entry_at).getTime();
      if (!(selectedPrice > 0) || !Number.isFinite(selectedAt)) continue;
      next.set(String(row.ca), {
        paperTradeId: Number(row.id),
        ca: String(row.ca),
        signal: String(row.signal || 'quality'),
        selectedAt,
        selectedPrice,
      });
    }
    references.clear();
    for (const [ca, reference] of next) references.set(ca, reference);
    diag.loaded = references.size;
    diag.lastSuccessAt = new Date().toISOString();
    diag.lastError = null;
  } catch (error) {
    // The schema may still be initializing during boot. Keep the prior safe references
    // and retry on the next short interval instead of allowing an unvalidated entry.
    diag.lastError = (error as Error).message;
  } finally {
    refreshing = false;
  }
}

export function startEntryRevalidation() {
  if (started || !pool) return;
  started = true;
  const initial = setTimeout(() => void refreshQualityReferences(), 1_000);
  initial.unref();
  const timer = setInterval(() => void refreshQualityReferences(), REFRESH_MS);
  timer.unref();
}

export function assessEntryRevalidation(token: TokenRecord, now = Date.now()): EntryRevalidationAssessment {
  const reference = references.get(token.ca) || null;
  const blockers: string[] = [];
  const reasons: string[] = [];
  const selectedPrice = reference?.selectedPrice || null;
  const selectionPremiumPct = selectedPrice && selectedPrice > 0 && token.priceUsd > 0
    ? (token.priceUsd / selectedPrice - 1) * 100 : null;
  const qualityTooLate = selectionPremiumPct !== null && selectionPremiumPct >= cfg().states.extended_pct;

  const isCurveToken = token.dex === 'pumpfun';
  const liquidityReady = isCurveToken
    ? token.curveSol >= cfg().gates.min_liquidity_sol_curve
    : token.liquidityUsd >= cfg().gates.min_liquidity_usd;

  const retention = token.earlyBuyers.length >= 5
    ? Math.max(0, 1 - token.earlyExited.length / token.earlyBuyers.length) : null;
  const retentionReady = retention === null || retention >= cfg().bestbuys.min_retention;

  const movedFromFirstScorePct = token.firstScorePrice && token.firstScorePrice > 0 && token.priceUsd > 0
    ? (token.priceUsd / token.firstScorePrice - 1) * 100 : null;
  const marketContinuityReady = token.source === 'aged'
    || movedFromFirstScorePct === null
    || movedFromFirstScorePct > -80;

  if (!reference || now - reference.selectedAt > MAX_REFERENCE_AGE_MS) {
    blockers.push('quality selection reference unavailable or stale');
  } else {
    reasons.push(`Quality observation ${reference.paperTradeId} remains the entry reference.`);
  }
  if (qualityTooLate) {
    blockers.push(`price is ${selectionPremiumPct!.toFixed(1)}% above the quality-selection price`);
  } else if (selectionPremiumPct !== null) {
    reasons.push(`Price is ${selectionPremiumPct.toFixed(1)}% from the quality-selection price, inside the ${cfg().states.extended_pct}% ceiling.`);
  }
  if (!liquidityReady) {
    blockers.push(isCurveToken
      ? `curve liquidity ${token.curveSol.toFixed(2)} SOL is below ${cfg().gates.min_liquidity_sol_curve} SOL`
      : `liquidity $${token.liquidityUsd.toFixed(2)} is below $${cfg().gates.min_liquidity_usd}`);
  } else {
    reasons.push(isCurveToken
      ? `Curve liquidity remains above ${cfg().gates.min_liquidity_sol_curve} SOL.`
      : `DEX liquidity remains above $${cfg().gates.min_liquidity_usd}.`);
  }
  if (!retentionReady && retention !== null) {
    blockers.push(`early-buyer retention ${(retention * 100).toFixed(1)}% is below ${(cfg().bestbuys.min_retention * 100).toFixed(1)}%`);
  } else if (retention !== null) {
    reasons.push(`Early-buyer retention is ${(retention * 100).toFixed(1)}%.`);
  }
  if (!marketContinuityReady && movedFromFirstScorePct !== null) {
    blockers.push(`price is down ${Math.abs(movedFromFirstScorePct).toFixed(1)}% from first score; lifecycle or price continuity must reset`);
  } else if (movedFromFirstScorePct !== null) {
    reasons.push(`Price continuity from first score is ${movedFromFirstScorePct.toFixed(1)}%.`);
  }

  return {
    revalidationReady: blockers.length === 0,
    revalidationBlockers: blockers,
    revalidationReasons: reasons,
    qualityReference: reference,
    selectionPremiumPct,
    liquidityReady,
    retentionReady,
    marketContinuityReady,
    qualityTooLate,
    earlyRetention: retention,
    movedFromFirstScorePct,
  };
}
