import { pool } from '../db';
import { MODEL_VERSION } from './version';

export const PROMOTION_THRESHOLDS = {
  minResolvedExecutable: 100,
  minHoldoutResolved: 30,
  minRegimes: 2,
  minTargetRateLift: 0.02,
  minMedianReturnLift: 0.05,
  maxSevereLossRateDelta: 0.02,
} as const;

export interface PromotionSample {
  signal: string;
  entryAt: number;
  multiple: number;
  verifiedTarget: boolean;
  regime: string | null;
}

export interface PromotionAssessment {
  ready: boolean;
  modelResolved: number;
  holdoutResolved: number;
  incumbentResolved: number;
  regimes: number;
  falsificationPassed: boolean;
  modelTargetRate: number | null;
  incumbentTargetRate: number | null;
  modelMedianReturn: number | null;
  incumbentMedianReturn: number | null;
  modelSevereLossRate: number | null;
  incumbentSevereLossRate: number | null;
  reasons: string[];
}

const emptyAssessment = (): PromotionAssessment => ({
  ready: false,
  modelResolved: 0,
  holdoutResolved: 0,
  incumbentResolved: 0,
  regimes: 0,
  falsificationPassed: false,
  modelTargetRate: null,
  incumbentTargetRate: null,
  modelMedianReturn: null,
  incumbentMedianReturn: null,
  modelSevereLossRate: null,
  incumbentSevereLossRate: null,
  reasons: ['promotion evidence has not been evaluated'],
});

let current = emptyAssessment();
let refreshedAt: string | null = null;
let lastError: string | null = null;
let started = false;

export const promotionReady = () => current.ready;
export const promotionStatus = () => ({ ...current, thresholds: PROMOTION_THRESHOLDS, refreshedAt, lastError });

export function startPromotionGate() {
  if (started) return;
  started = true;
  refreshPromotionGate().catch(() => {});
  const timer = setInterval(() => refreshPromotionGate().catch(() => {}), 15 * 60_000);
  timer.unref();
}

export function assessPromotion(samples: PromotionSample[], falsificationPassed: boolean): PromotionAssessment {
  const valid = samples
    .filter(sample => Number.isFinite(sample.multiple) && sample.multiple > 0)
    .sort((a, b) => a.entryAt - b.entryAt);
  const model = valid.filter(sample => sample.signal === 'model_executable');
  const holdout = model.slice(-PROMOTION_THRESHOLDS.minHoldoutResolved);
  const holdoutStart = holdout[0]?.entryAt ?? Number.POSITIVE_INFINITY;
  const incumbent = valid.filter(sample => !sample.signal.startsWith('model') && sample.entryAt >= holdoutStart);
  const regimes = new Set(model.map(sample => sample.regime).filter((value): value is string => !!value)).size;

  const modelTargetRate = rate(model, sample => sample.verifiedTarget);
  const incumbentTargetRate = rate(incumbent, sample => sample.verifiedTarget);
  const modelMedianReturn = median(model.map(sample => sample.multiple));
  const incumbentMedianReturn = median(incumbent.map(sample => sample.multiple));
  const modelSevereLossRate = rate(model, sample => sample.multiple <= 0.5);
  const incumbentSevereLossRate = rate(incumbent, sample => sample.multiple <= 0.5);

  const reasons: string[] = [];
  if (model.length < PROMOTION_THRESHOLDS.minResolvedExecutable)
    reasons.push(`model executable samples ${model.length}/${PROMOTION_THRESHOLDS.minResolvedExecutable}`);
  if (holdout.length < PROMOTION_THRESHOLDS.minHoldoutResolved)
    reasons.push(`later holdout samples ${holdout.length}/${PROMOTION_THRESHOLDS.minHoldoutResolved}`);
  if (!incumbent.length) reasons.push('no incumbent executable comparison in the holdout window');
  if (regimes < PROMOTION_THRESHOLDS.minRegimes)
    reasons.push(`regime coverage ${regimes}/${PROMOTION_THRESHOLDS.minRegimes}`);
  if (!falsificationPassed) reasons.push('latest chronological evaluation has not passed placebo tests');

  if (modelTargetRate !== null && incumbentTargetRate !== null
      && modelTargetRate < incumbentTargetRate + PROMOTION_THRESHOLDS.minTargetRateLift) {
    reasons.push(`target-rate lift ${(modelTargetRate - incumbentTargetRate).toFixed(3)} < ${PROMOTION_THRESHOLDS.minTargetRateLift}`);
  }
  if (modelMedianReturn !== null && incumbentMedianReturn !== null
      && modelMedianReturn < incumbentMedianReturn + PROMOTION_THRESHOLDS.minMedianReturnLift) {
    reasons.push(`median-return lift ${(modelMedianReturn - incumbentMedianReturn).toFixed(3)} < ${PROMOTION_THRESHOLDS.minMedianReturnLift}`);
  }
  if (modelSevereLossRate !== null && incumbentSevereLossRate !== null
      && modelSevereLossRate > incumbentSevereLossRate + PROMOTION_THRESHOLDS.maxSevereLossRateDelta) {
    reasons.push(`severe-loss delta ${(modelSevereLossRate - incumbentSevereLossRate).toFixed(3)} > ${PROMOTION_THRESHOLDS.maxSevereLossRateDelta}`);
  }

  return {
    ready: reasons.length === 0,
    modelResolved: model.length,
    holdoutResolved: holdout.length,
    incumbentResolved: incumbent.length,
    regimes,
    falsificationPassed,
    modelTargetRate,
    incumbentTargetRate,
    modelMedianReturn,
    incumbentMedianReturn,
    modelSevereLossRate,
    incumbentSevereLossRate,
    reasons,
  };
}

async function refreshPromotionGate() {
  if (!pool) {
    current = { ...emptyAssessment(), reasons: ['database unavailable; enforcement promotion disabled'] };
    refreshedAt = new Date().toISOString();
    return;
  }
  try {
    const result = await pool.query(
      `SELECT paper.signal,EXTRACT(EPOCH FROM paper.entry_at)*1000 AS entry_at,
              COALESCE(paper.exit_price,paper.last_price)/NULLIF(paper.entry_price,0) AS multiple,
              paper.target_hit_at IS NOT NULL AS verified_target,
              NULLIF(split_part(decision.regime_id,':',2),'') AS regime
         FROM paper_trades paper
         LEFT JOIN signal_decisions decision ON decision.id=paper.signal_decision_id
        WHERE paper.model_version=$1 AND paper.execution_eligible=true AND paper.closed=true
          AND paper.exit_reason IS DISTINCT FROM 'tracking_lost'
          AND paper.entry_at>now()-interval '30 days'
        ORDER BY paper.entry_at`,
      [MODEL_VERSION],
    );
    const evaluation = await pool.query(
      `SELECT passed_falsification FROM model_evaluations
        WHERE model_version=$1 ORDER BY evaluated_at DESC LIMIT 1`,
      [MODEL_VERSION],
    );
    current = assessPromotion(result.rows.map(row => ({
      signal: String(row.signal),
      entryAt: Number(row.entry_at),
      multiple: Number(row.multiple),
      verifiedTarget: !!row.verified_target,
      regime: row.regime ? String(row.regime) : null,
    })), !!evaluation.rows[0]?.passed_falsification);
    refreshedAt = new Date().toISOString();
    lastError = null;
  } catch (error) {
    lastError = (error as Error).message;
    current = { ...current, ready: false, reasons: [`promotion evaluation failed: ${lastError}`] };
    console.error('[model-promotion]', lastError);
  }
}

function rate<T>(rows: T[], predicate: (row: T) => boolean): number | null {
  if (!rows.length) return null;
  return rows.filter(predicate).length / rows.length;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
