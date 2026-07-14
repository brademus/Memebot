import { pool } from '../db';
import { brierScore, deterministicShuffle, mean, percentile, round } from './math';
import { MODEL_VERSION } from './version';

interface Row {
  at: number;
  creator: string;
  regime: string;
  probability: number;
  allow: boolean;
  success: number;
  returnMultiple: number;
}

const diag = { lastRun: null as string | null, rows: 0, passedFalsification: false, lastError: null as string | null };
export const evaluationDiag = () => ({ ...diag });

export function startModelEvaluator() {
  if (!pool) return;
  setTimeout(() => runModelEvaluation().catch(() => {}), 5 * 60_000);
  const timer = setInterval(() => runModelEvaluation().catch(() => {}), 6 * 3600_000);
  timer.unref();
}

export function evaluateRows(rows: Row[]) {
  const sorted = [...rows].sort((left, right) => left.at - right.at);
  const split = Math.max(1, Math.floor(sorted.length * 0.7));
  const train = sorted.slice(0, split);
  const test = sorted.slice(split);
  const trainCreators = new Set(train.map(row => row.creator).filter(Boolean));
  const unseen = test.filter(row => !row.creator || !trainCreators.has(row.creator));
  const scored = unseen.length >= Math.max(10, test.length * 0.25) ? unseen : test;
  const probabilities = scored.map(row => row.probability);
  const labels = scored.map(row => row.success);
  const allowed = scored.filter(row => row.allow);
  const actual = metrics(scored);
  const shuffledLabels = deterministicShuffle(labels, 71);
  const reversedProbabilities = [...probabilities].reverse();
  const placebo = {
    shuffled_brier: round(brierScore(probabilities, shuffledLabels)),
    shifted_brier: round(brierScore(reversedProbabilities, labels)),
    shuffled_precision: round(mean(allowed.map((_, index) => shuffledLabels[index % Math.max(1, shuffledLabels.length)]))),
  };
  return {
    trainRows: train.length, testRows: test.length, unseenCreatorRows: unseen.length,
    metrics: actual, placebo,
    passedFalsification: scored.length >= 20
      && actual.brier < Math.min(placebo.shuffled_brier, placebo.shifted_brier)
      && actual.allow_precision >= placebo.shuffled_precision,
    evaluatedRows: scored,
  };
}

export async function runModelEvaluation() {
  if (!pool) return;
  try {
    const result = await pool.query(
      `SELECT EXTRACT(EPOCH FROM decision.evaluated_at)*1000 AS at,
              COALESCE(token.creator,'') AS creator,
              split_part(decision.regime_id,':',2) AS regime,
              decision.target_before_stop_probability AS probability,
              decision.allow,
              CASE WHEN outcome.first_event='target_2x' THEN 1 ELSE 0 END AS success,
              outcome.max_multiple AS return_multiple
         FROM signal_decisions decision
         JOIN signal_decision_outcomes outcome ON outcome.decision_id=decision.id
         JOIN tokens token ON token.ca=decision.ca
        WHERE decision.model_version=$1 AND outcome.status='resolved' AND NOT outcome.tracking_gap
          AND decision.evaluated_at>now()-interval '60 days'
        ORDER BY decision.evaluated_at`, [MODEL_VERSION],
    );
    const rows: Row[] = result.rows.map(row => ({
      at: Number(row.at), creator: String(row.creator || ''), regime: String(row.regime || 'unknown'),
      probability: Number(row.probability) || 0, allow: !!row.allow,
      success: Number(row.success) || 0, returnMultiple: Number(row.return_multiple) || 0,
    }));
    diag.rows = rows.length;
    if (rows.length < 20) {
      diag.lastRun = new Date().toISOString();
      diag.lastError = null;
      return;
    }
    const evaluation = evaluateRows(rows);
    const regimeMetrics = Object.fromEntries([...new Set(evaluation.evaluatedRows.map(row => row.regime))]
      .map(regime => [regime, metrics(evaluation.evaluatedRows.filter(row => row.regime === regime))]));
    await pool.query(
      `INSERT INTO model_evaluations
         (model_version,window_start,window_end,train_rows,test_rows,metrics,regime_metrics,
          placebo_metrics,passed_falsification,notes)
       VALUES ($1,to_timestamp($2/1000.0),to_timestamp($3/1000.0),$4,$5,$6,$7,$8,$9,$10)`,
      [MODEL_VERSION, rows[0].at, rows[rows.length - 1].at, evaluation.trainRows, evaluation.testRows,
       JSON.stringify({ ...evaluation.metrics, unseen_creator_rows: evaluation.unseenCreatorRows }),
       JSON.stringify(regimeMetrics), JSON.stringify(evaluation.placebo), evaluation.passedFalsification,
       'Chronological 70/30 walk-forward; test prefers creators absent from training; shuffled-label and time-shift placebos must lose.'],
    );
    diag.passedFalsification = evaluation.passedFalsification;
    diag.lastRun = new Date().toISOString();
    diag.lastError = null;
  } catch (error) {
    diag.lastError = (error as Error).message;
    console.error('[model-evaluation]', diag.lastError);
  }
}

function metrics(rows: Row[]) {
  const probabilities = rows.map(row => row.probability);
  const labels = rows.map(row => row.success);
  const allowed = rows.filter(row => row.allow);
  const returns = allowed.map(row => row.returnMultiple).sort((left, right) => left - right);
  const bins = new Map<number, Row[]>();
  for (const row of rows) {
    const bin = Math.min(9, Math.floor(row.probability * 10));
    if (!bins.has(bin)) bins.set(bin, []);
    bins.get(bin)!.push(row);
  }
  const calibrationError = rows.length ? [...bins.values()].reduce((sum, bin) => {
    const predicted = mean(bin.map(row => row.probability));
    const observed = mean(bin.map(row => row.success));
    return sum + Math.abs(predicted - observed) * bin.length / rows.length;
  }, 0) : 0;
  const cutoff = Math.max(1, Math.ceil(rows.length * 0.1));
  const top = [...rows].sort((left, right) => right.probability - left.probability).slice(0, cutoff);
  return {
    n: rows.length,
    base_rate: round(mean(labels)),
    brier: round(brierScore(probabilities, labels)),
    calibration_error: round(calibrationError),
    top_decile_precision: round(mean(top.map(row => row.success))),
    allow_n: allowed.length,
    allow_precision: round(mean(allowed.map(row => row.success))),
    allow_median_multiple: round(percentile(returns, 0.5)),
    allow_cvar10: round(mean(returns.slice(0, Math.max(1, Math.ceil(returns.length * 0.1))))),
    allow_loss_rate: round(mean(allowed.map(row => row.returnMultiple < 1 ? 1 : 0))),
  };
}
