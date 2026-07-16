import { pool } from '../db';
import { fetchTokenSnapshot } from '../ingest/dexscreener';
import { allTokens } from '../store';
import { TokenRecord } from '../types';
import {
  MODEL_VERSION,
  SCORE_FORWARD_MINUTES,
  SCORE_SNAPSHOT_AGES_MIN,
  SNAPSHOT_CAPTURE_TOLERANCE_MIN,
  recommendationEligibleSource,
} from '../model/version';

const attempted = new Set<string>();
const processStartedAt = Date.now();
const MAX_RESOLVE_ATTEMPTS = 8;
const RETRY_MINUTES = [2, 5, 15, 30, 60, 180, 360, 720];
let resolving = false;

const diag = {
  modelVersion: MODEL_VERSION,
  captured: 0,
  resolved: 0,
  missedWindows: 0,
  lastResolve: null as string | null,
  lastError: null as string | null,
};

export const forwardEvidenceDiag = () => ({ ...diag, attempted: attempted.size });

export function snapshotAgeDue(ageMinutes: number): number | null {
  for (const target of SCORE_SNAPSHOT_AGES_MIN) {
    if (ageMinutes >= target && ageMinutes < target + SNAPSHOT_CAPTURE_TOLERANCE_MIN) return target;
  }
  return null;
}

export function startForwardEvidenceCollector() {
  if (!pool) return;
  const captureTick = () => {
    for (const token of allTokens()) capture(token).catch(error => {
      diag.lastError = (error as Error).message;
      console.error('[forward-evidence:capture]', diag.lastError);
    });
    stampCurrentRecommendations().catch(error => console.error('[forward-evidence:stamp]', (error as Error).message));
  };
  const firstCapture = setTimeout(captureTick, 20_000); firstCapture.unref();
  const captureTimer = setInterval(captureTick, 5_000); captureTimer.unref();
  const resolve = () => resolveDue().catch(error => {
    diag.lastError = (error as Error).message;
    console.error('[forward-evidence:resolve]', diag.lastError);
  });
  const firstResolve = setTimeout(resolve, 60_000); firstResolve.unref();
  const resolveTimer = setInterval(resolve, 60_000); resolveTimer.unref();
}

async function capture(token: TokenRecord) {
  if (!pool || token.gated !== true || token.priceUsd <= 0 || !token.subs?.raw) return;
  const ageMinutes = (Date.now() - token.firstSeen) / 60_000;
  const target = snapshotAgeDue(ageMinutes);
  if (target === null) return;
  const key = `${MODEL_VERSION}:${token.ca}:${target}`;
  if (attempted.has(key)) return;
  attempted.add(key);

  const result = await pool.query(
    `INSERT INTO score_snapshots
       (ca, snapshot_age_min, captured_age_seconds, captured_at, price_usd, score,
        raw, source, recommendation_eligible, model_version, forward_minutes)
     VALUES ($1,$2::int,$3::int,now(),$4::numeric,$5::numeric,$6::jsonb,$7,$8,$9,$10::int)
     ON CONFLICT (ca, snapshot_age_min, model_version) DO NOTHING`,
    [
      token.ca,
      target,
      Math.max(0, Math.round((Date.now() - token.firstSeen) / 1000)),
      token.priceUsd,
      token.score,
      JSON.stringify(token.subs.raw),
      token.source,
      recommendationEligibleSource(token.source),
      MODEL_VERSION,
      SCORE_FORWARD_MINUTES,
    ],
  );
  if (result.rowCount) diag.captured++;
}

async function resolveDue() {
  if (!pool || resolving) return;
  resolving = true;
  diag.lastResolve = new Date().toISOString();
  diag.lastError = null;
  try {
    const due = await pool.query(
      `SELECT id, ca, price_usd, forward_minutes, resolve_attempts
         FROM score_snapshots
        WHERE model_version=$1
          AND resolve_status='pending'
          AND captured_at <= now() - make_interval(mins => forward_minutes)
          AND captured_at > now() - interval '72 hours'
          AND next_resolve_at <= now()
        ORDER BY captured_at ASC
        LIMIT 200`,
      [MODEL_VERSION],
    );

    const concurrency = 8;
    for (let index = 0; index < due.rows.length; index += concurrency) {
      await Promise.all(due.rows.slice(index, index + concurrency).map(async (row: any) => {
        const snapshot = await fetchTokenSnapshot(row.ca);
        if (!snapshot || !Number.isFinite(snapshot.price) || snapshot.price <= 0) {
          const attempt = Number(row.resolve_attempts || 0) + 1;
          const retry = RETRY_MINUTES[Math.min(attempt - 1, RETRY_MINUTES.length - 1)];
          await pool!.query(
            `UPDATE score_snapshots
                SET resolve_attempts=$2::int,
                    last_resolve_error='Dexscreener snapshot unavailable',
                    next_resolve_at=now()+make_interval(mins => $3::int),
                    resolve_status=CASE WHEN $2::int >= $4::int THEN 'unresolved' ELSE 'pending' END
              WHERE id=$1::bigint`,
            [row.id, attempt, retry, MAX_RESOLVE_ATTEMPTS],
          );
          return;
        }
        const entry = Number(row.price_usd);
        await pool!.query(
          `UPDATE score_snapshots
              SET forward_price_usd=$2::numeric,
                  forward_multiple=$2::numeric/NULLIF(price_usd,0),
                  resolved_at=now(), resolve_status='resolved',
                  last_resolve_error=NULL
            WHERE id=$1::bigint AND resolve_status='pending'`,
          [row.id, snapshot.price],
        );
        if (entry > 0) diag.resolved++;
      }));
    }
  } catch (error) {
    diag.lastError = (error as Error).message;
    console.error('[forward-evidence]', diag.lastError);
  } finally {
    resolving = false;
  }
}

async function stampCurrentRecommendations() {
  if (!pool) return;
  for (const token of allTokens()) {
    if (token.triggeredAt && token.triggeredAt >= processStartedAt) {
      await pool.query(
        `UPDATE tokens SET trigger_model_version=COALESCE(trigger_model_version,$2)
          WHERE ca=$1 AND triggered_at IS NOT NULL`,
        [token.ca, MODEL_VERSION],
      );
    }
    if (token.convictionAt && token.convictionAt >= processStartedAt) {
      await pool.query(
        `UPDATE tokens SET conviction_model_version=COALESCE(conviction_model_version,$2)
          WHERE ca=$1 AND conviction_at IS NOT NULL`,
        [token.ca, MODEL_VERSION],
      );
    }
  }
}
