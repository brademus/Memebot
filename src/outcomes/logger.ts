import { cfg } from '../config';
import { fetchTokenSnapshot } from '../ingest/dexscreener';
import { logOutcome, markRug, pool } from '../db';

// Outcome snapshots are model labels. A temporary provider outage must never become
// a permanent 0x label, because that poisons scoring calibration, deployer reputation,
// false-kill analysis, and every downstream learning loop.
const MAX_FAILURES = 8;
const RETRY_MINUTES = [2, 5, 15, 30, 60, 180, 360, 720];
let running = false;

export function startOutcomeLogger() {
  if (!pool) return;

  pool.query(`
    CREATE TABLE IF NOT EXISTS outcome_fetch_failures (
      ca TEXT NOT NULL,
      snapshot_minutes INT NOT NULL,
      attempts INT NOT NULL DEFAULT 0,
      last_error TEXT,
      last_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (ca, snapshot_minutes)
    )
  `).then(() => tick()).catch(e => console.error('[outcomes] retry table:', e.message));

  setInterval(() => tick().catch(e => console.error('[outcomes]', e.message)), 60_000);
}

async function tick() {
  if (!pool || running) return;
  running = true;
  try {
    for (const m of cfg().polling.outcome_snapshot_minutes) {
      const due = await pool.query(
        `SELECT t.ca, t.first_score_price, t.gate_result,
                COALESCE(f.attempts, 0)::int AS fetch_attempts
         FROM tokens t
         LEFT JOIN outcome_fetch_failures f
           ON f.ca = t.ca AND f.snapshot_minutes = $2
         WHERE t.first_seen <= now() - ($1 || ' minutes')::interval
           AND t.first_seen > now() - interval '48 hours'
           AND t.first_score_price IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM outcomes o
             WHERE o.ca = t.ca AND o.snapshot_minutes = $2
           )
           AND COALESCE(f.attempts, 0) < $3
           AND (f.next_attempt_at IS NULL OR f.next_attempt_at <= now())
         LIMIT 200`,
        [String(m), m, MAX_FAILURES]);

      // Bounded concurrency keeps up with launch volume without hammering the provider.
      const CONCURRENCY = 8;
      for (let i = 0; i < due.rows.length; i += CONCURRENCY) {
        await Promise.all(due.rows.slice(i, i + CONCURRENCY).map(async (row: any) => {
          const snap = await fetchTokenSnapshot(row.ca);
          if (!snap) {
            const attempt = Number(row.fetch_attempts || 0) + 1;
            const retryMinutes = RETRY_MINUTES[Math.min(attempt - 1, RETRY_MINUTES.length - 1)];
            await pool!.query(
              `INSERT INTO outcome_fetch_failures
                 (ca, snapshot_minutes, attempts, last_error, last_attempt_at, next_attempt_at)
               VALUES ($1, $2, 1, $3, now(), now() + ($4 || ' minutes')::interval)
               ON CONFLICT (ca, snapshot_minutes) DO UPDATE
                 SET attempts = outcome_fetch_failures.attempts + 1,
                     last_error = EXCLUDED.last_error,
                     last_attempt_at = now(),
                     next_attempt_at = now() + ($4 || ' minutes')::interval`,
              [row.ca, m, 'Dexscreener snapshot unavailable', String(retryMinutes)]);
            return;
          }

          await logOutcome(row.ca, m, snap.price, snap.liq, snap.mcap, row.first_score_price);
          await pool!.query(
            `DELETE FROM outcome_fetch_failures WHERE ca = $1 AND snapshot_minutes = $2`,
            [row.ca, m]).catch(() => {});

          if (row.gate_result === 'passed' && row.first_score_price &&
              snap.price < row.first_score_price * 0.05 && cfg().deployer.blacklist_auto) {
            await markRug(row.ca);
          }
        }));
      }
    }
  } finally {
    running = false;
  }
}
