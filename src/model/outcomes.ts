import { pool } from '../db';
import { getToken } from '../store';
import { MODEL_VERSION } from './version';

let running = false;
const diag = { tracked: 0, resolved: 0, gaps: 0, calibrated: 0, lastRun: null as string | null, lastError: null as string | null };
export const decisionOutcomeDiag = () => ({ ...diag });

export function startDecisionOutcomeTracker() {
  if (!pool) return;
  const tick = () => updateOutcomes().catch(error => {
    diag.lastError = (error as Error).message;
    console.error('[decision-outcomes]', diag.lastError);
  });
  setTimeout(tick, 20_000);
  const timer = setInterval(tick, 15_000);
  timer.unref();
  setTimeout(() => rebuildCalibration().catch(() => {}), 90_000);
  const calibrationTimer = setInterval(() => rebuildCalibration().catch(() => {}), 15 * 60_000);
  calibrationTimer.unref();
}

async function updateOutcomes() {
  if (!pool || running) return;
  running = true;
  try {
    const rows = await pool.query(
      `SELECT decision.id,decision.ca,decision.evaluated_at,decision.price_usd,
              outcome.status,outcome.max_multiple,outcome.min_multiple,outcome.first_event
         FROM signal_decisions decision
         JOIN signal_decision_outcomes outcome ON outcome.decision_id=decision.id
        WHERE decision.model_version=$1
          AND decision.evaluated_at>now()-interval '8 hours'
          AND (outcome.status='tracking' OR decision.evaluated_at>now()-interval '4 hours')
        ORDER BY decision.evaluated_at LIMIT 500`, [MODEL_VERSION],
    );
    diag.tracked = rows.rows.length;
    for (const row of rows.rows) {
      const token = getToken(row.ca);
      const ageMs = Date.now() - new Date(row.evaluated_at).getTime();
      if (!token || !token.priceUsd || token.priceUsd <= 0) {
        if (ageMs > 20 * 60_000) {
          await pool.query(
            `UPDATE signal_decision_outcomes SET tracking_gap=true,updated_at=now() WHERE decision_id=$1`, [row.id],
          );
          diag.gaps++;
        }
        continue;
      }
      const entry = Number(row.price_usd);
      const multiple = token.priceUsd / entry;
      const maximum = Math.max(Number(row.max_multiple) || 1, multiple);
      const minimum = Math.min(Number(row.min_multiple) || 1, multiple);
      const event = row.first_event || firstEvent(token.state, multiple, ageMs);
      const resolved = !!event;
      await pool.query(
        `UPDATE signal_decision_outcomes
            SET last_price=$2,last_multiple=$3,max_multiple=$4,min_multiple=$5,
                first_event=COALESCE(first_event,$6),
                first_event_at=CASE WHEN first_event IS NULL AND $6::text IS NOT NULL THEN now() ELSE first_event_at END,
                route_lost_at=CASE WHEN first_event IS NULL AND $6='route_loss' THEN now() ELSE route_lost_at END,
                status=CASE WHEN $7 THEN 'resolved' ELSE status END,
                resolved_at=CASE WHEN $7 AND resolved_at IS NULL THEN now() ELSE resolved_at END,
                updated_at=now()
          WHERE decision_id=$1`,
        [row.id, token.priceUsd, multiple, maximum, minimum, event, resolved],
      );
      if (resolved && !row.first_event) diag.resolved++;
    }
    diag.lastRun = new Date().toISOString();
    diag.lastError = null;
  } finally { running = false; }
}

function firstEvent(state: string, multiple: number, ageMs: number): string | null {
  if (multiple <= 0.05) return 'rug';
  if (multiple <= 0.50) return 'stop_50pct';
  if (multiple <= 0.70) return 'stop_30pct';
  if (multiple >= 2) return 'target_2x';
  if (state === 'DEAD') return 'route_loss';
  if (ageMs >= 4 * 3600_000) return 'timeout';
  return null;
}

async function rebuildCalibration() {
  if (!pool) return;
  const rows = await pool.query(
    `WITH labeled AS (
       SELECT split_part(decision.regime_id,':',2) AS regime_kind,
              LEAST(9,GREATEST(0,FLOOR(decision.target_before_stop_probability*10)::int)) AS probability_bin,
              outcome.first_event='target_2x' AS success
         FROM signal_decisions decision
         JOIN signal_decision_outcomes outcome ON outcome.decision_id=decision.id
        WHERE decision.model_version=$1 AND outcome.status='resolved' AND NOT outcome.tracking_gap
          AND decision.evaluated_at>now()-interval '30 days')
     SELECT regime_kind,probability_bin,COUNT(*)::int AS observations,
            COUNT(*) FILTER (WHERE success)::int AS successes
       FROM labeled GROUP BY regime_kind,probability_bin`, [MODEL_VERSION],
  ).catch(() => ({ rows: [] as any[] }));
  await pool.query(`DELETE FROM model_calibration_bins WHERE model_version=$1`, [MODEL_VERSION]).catch(() => {});
  let total = 0;
  for (const row of rows.rows) {
    const observations = Number(row.observations) || 0;
    const successes = Number(row.successes) || 0;
    const posterior = (successes + 1) / (observations + 2);
    await pool.query(
      `INSERT INTO model_calibration_bins
         (model_version,regime_kind,probability_bin,observations,successes,posterior_probability,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,now())`,
      [MODEL_VERSION, row.regime_kind || 'all', row.probability_bin, observations, successes, posterior],
    );
    total += observations;
  }
  // Global bins make calibration usable in sparse regimes.
  const global = await pool.query(
    `WITH labeled AS (
       SELECT LEAST(9,GREATEST(0,FLOOR(decision.target_before_stop_probability*10)::int)) AS probability_bin,
              outcome.first_event='target_2x' AS success
         FROM signal_decisions decision JOIN signal_decision_outcomes outcome ON outcome.decision_id=decision.id
        WHERE decision.model_version=$1 AND outcome.status='resolved' AND NOT outcome.tracking_gap
          AND decision.evaluated_at>now()-interval '30 days')
     SELECT probability_bin,COUNT(*)::int observations,COUNT(*) FILTER (WHERE success)::int successes
       FROM labeled GROUP BY probability_bin`, [MODEL_VERSION],
  ).catch(() => ({ rows: [] as any[] }));
  for (const row of global.rows) {
    const observations = Number(row.observations) || 0, successes = Number(row.successes) || 0;
    await pool.query(
      `INSERT INTO model_calibration_bins
         (model_version,regime_kind,probability_bin,observations,successes,posterior_probability,updated_at)
       VALUES ($1,'all',$2,$3,$4,$5,now())`,
      [MODEL_VERSION, row.probability_bin, observations, successes, (successes + 1) / (observations + 2)],
    );
  }
  diag.calibrated = total;
}
