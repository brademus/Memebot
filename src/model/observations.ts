import { pool } from '../db';
import { fetchTokenSnapshot } from '../ingest/dexscreener';
import { allTokens, getToken } from '../store';
import { burstFeatures } from './burst';
import { buildSignalFeatures } from './features';
import { currentRegime } from './regime';
import { CURVE_MILESTONES, MODEL_VERSION, SCORE_SNAPSHOT_AGES_MIN, SIGNAL_FORWARD_HORIZONS_MIN, SNAPSHOT_CAPTURE_TOLERANCE_MIN, recommendationEligibleSource } from './version';
import { CURVE_SPAN_SOL, CURVE_START_SOL } from '../constants';

const attempted = new Set<string>();
let resolving = false;
const MAX_ATTEMPTS = 8;
const RETRIES = [2, 5, 15, 30, 60, 180, 360, 720];
const diag = {
  captured: 0, resolved: 0, resolvedLive: 0, resolvedDex: 0, unresolved: 0,
  captureErrors: 0, lastCapture: null as string | null, lastResolve: null as string | null,
  lastError: null as string | null,
};
export const observationDiag = () => ({ ...diag, attempted: attempted.size });

export function observationKeys(ageMinutes: number, curveProgress: number): string[] {
  const keys: string[] = [];
  for (const age of SCORE_SNAPSHOT_AGES_MIN)
    if (ageMinutes >= age && ageMinutes < age + SNAPSHOT_CAPTURE_TOLERANCE_MIN) keys.push(`age_${age}m`);
  const reached = [...CURVE_MILESTONES].filter(milestone => curveProgress >= milestone).pop();
  if (reached !== undefined) keys.push(`curve_${Math.round(reached * 100)}pct`);
  return keys;
}

export function startSignalObservationCollector() {
  if (!pool) return;
  const capture = () => captureAll().catch(error => {
    diag.lastError = (error as Error).message;
    console.error('[signal-observations:capture]', diag.lastError);
  });
  const firstCapture = setTimeout(capture, 15_000); firstCapture.unref();
  const captureTimer = setInterval(capture, 5_000); captureTimer.unref();
  const resolve = () => resolveDue().catch(error => {
    diag.lastError = (error as Error).message;
    console.error('[signal-observations:resolve]', diag.lastError);
  });
  const firstResolve = setTimeout(resolve, 60_000); firstResolve.unref();
  const resolveTimer = setInterval(resolve, 60_000); resolveTimer.unref();
}

async function captureAll() {
  if (!pool) return;
  const now = Date.now();
  const regime = currentRegime();
  for (const token of allTokens()) {
    if (token.gated !== true || token.priceUsd <= 0 || token.state === 'DEAD') continue;
    const ageMinutes = (now - token.firstSeen) / 60_000;
    const curveProgress = token.dex === 'pumpfun'
      ? Math.max(0, Math.min(1, (token.curveSol - CURVE_START_SOL) / Math.max(1, CURVE_SPAN_SOL)))
      : token.gradAt ? 1 : 0;
    for (const key of observationKeys(ageMinutes, curveProgress)) {
      const identity = `${MODEL_VERSION}:${token.ca}:${key}`;
      if (attempted.has(identity)) continue;
      attempted.add(identity);
      try {
        const features = buildSignalFeatures(token, regime, now);
        const burst = burstFeatures(token, now);
        const inserted = await pool.query(
          `INSERT INTO signal_observations
             (ca,observation_key,captured_at,captured_age_seconds,price_usd,base_score,source,dex,
              regime_id,model_version,recommendation_eligible,feature_vector,burst_features,entity_features,decision)
           VALUES ($1,$2,to_timestamp($3::double precision/1000.0),$4::int,$5::numeric,$6::numeric,$7,$8,$9,$10,$11,
                   $12::jsonb,$13::jsonb,$14::jsonb,$15::jsonb)
           ON CONFLICT (ca,observation_key,model_version) DO NOTHING RETURNING id`,
          [token.ca, key, now, Math.round(ageMinutes * 60), token.priceUsd, token.score, token.source,
           token.dex, regime.id, MODEL_VERSION, recommendationEligibleSource(token.source),
           JSON.stringify(features), JSON.stringify(burst), token.entityGraph ? JSON.stringify(token.entityGraph) : null,
           token.modelDecision ? JSON.stringify(token.modelDecision) : null],
        );
        const id = inserted.rows[0]?.id;
        if (!id) continue;
        diag.captured++;
        for (const horizon of SIGNAL_FORWARD_HORIZONS_MIN) await pool.query(
          `INSERT INTO signal_observation_outcomes (observation_id,horizon_minutes)
           VALUES ($1::bigint,$2::int) ON CONFLICT DO NOTHING`,
          [id, horizon],
        );
      } catch (error) {
        attempted.delete(identity);
        diag.captureErrors++;
        diag.lastError = (error as Error).message;
        console.error('[signal-observations:capture]', diag.lastError);
      }
    }
  }
  diag.lastCapture = new Date().toISOString();
}

async function resolveDue() {
  if (!pool || resolving) return;
  resolving = true; diag.lastError = null;
  try {
    const rows = await pool.query(
      `SELECT outcome.observation_id,outcome.horizon_minutes,outcome.attempts,observation.ca,observation.price_usd,
              EXTRACT(EPOCH FROM observation.captured_at)*1000 AS captured_at_ms
         FROM signal_observation_outcomes outcome
         JOIN signal_observations observation ON observation.id=outcome.observation_id
        WHERE observation.model_version=$1 AND outcome.status='pending'
          AND observation.captured_at<=now()-make_interval(mins => outcome.horizon_minutes)
          AND outcome.next_attempt_at<=now() AND observation.captured_at>now()-interval '10 days'
        ORDER BY outcome.next_attempt_at,observation.captured_at LIMIT 250`, [MODEL_VERSION],
    );
    for (let index = 0; index < rows.rows.length; index += 8) {
      await Promise.all(rows.rows.slice(index, index + 8).map(async row => {
        const dueAt = Number(row.captured_at_ms) + Number(row.horizon_minutes) * 60_000;
        const snapshot = await resolveSnapshot(row.ca, dueAt);
        if (!snapshot || !Number.isFinite(snapshot.price) || snapshot.price <= 0) {
          const attempt = Number(row.attempts || 0) + 1;
          const retry = RETRIES[Math.min(attempt - 1, RETRIES.length - 1)];
          const terminal = attempt >= MAX_ATTEMPTS;
          await pool!.query(
            `UPDATE signal_observation_outcomes
                SET attempts=$3::int,last_error='market snapshot unavailable',
                    next_attempt_at=now()+make_interval(mins => $4::int),status=$5::text
              WHERE observation_id=$1::bigint AND horizon_minutes=$2::int`,
            [row.observation_id, row.horizon_minutes, attempt, retry, terminal ? 'unresolved' : 'pending'],
          );
          if (terminal) diag.unresolved++;
          return;
        }
        await pool!.query(
          `UPDATE signal_observation_outcomes
              SET status='resolved',price_usd=$3::numeric,
                  multiple=$3::numeric/NULLIF($4::numeric,0),resolved_at=now(),last_error=NULL
            WHERE observation_id=$1::bigint AND horizon_minutes=$2::int`,
          [row.observation_id, row.horizon_minutes, snapshot.price, row.price_usd],
        );
        diag.resolved++;
        if (snapshot.source === 'live') diag.resolvedLive++; else diag.resolvedDex++;
      }));
    }
    diag.lastResolve = new Date().toISOString();
  } catch (error) {
    diag.lastError = (error as Error).message;
    console.error('[signal-observations]', diag.lastError);
  } finally { resolving = false; }
}

async function resolveSnapshot(ca: string, dueAt: number): Promise<{ price: number; source: 'live' | 'dex' } | null> {
  const now = Date.now();
  const token = getToken(ca);
  if (token && token.priceUsd > 0) {
    const recentTradeAt = token.recentTrades[token.recentTrades.length - 1]?.at || 0;
    const curveAt = token.curveSamples[token.curveSamples.length - 1]?.at || 0;
    const updatedAt = Math.max(Number((token as any).marketUpdatedAt || 0), recentTradeAt, curveAt);
    if (updatedAt >= dueAt - 2 * 60_000 && now - updatedAt <= 3 * 60_000)
      return { price: token.priceUsd, source: 'live' };
  }
  const dex = await fetchTokenSnapshot(ca);
  return dex && dex.price > 0 ? { price: dex.price, source: 'dex' } : null;
}
