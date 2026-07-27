import type { PoolClient } from 'pg';
import { pool } from '../db';

// Rolling retention for paper_trade_snapshots: keep raw data for N days, then aggregate
// to daily summaries. This prevents the snapshots table from growing unbounded.
const RAW_RETENTION_DAYS = 7;
const AGGREGATE_RETENTION_DAYS = 90;
const BATCH_SIZE = 5000;
const INITIAL_DELAY_MS = 30_000;
const INTERVAL_MS = 6 * 60 * 60_000;

// Exported for testing: atomic batch SQL with bounded snapshot selection, aggregation, and deletion
export const PAPER_SNAPSHOT_RETENTION_BATCH_SQL = `WITH batch_ids AS (
  SELECT id FROM paper_trade_snapshots
  WHERE captured_at < $1::timestamptz
  ORDER BY captured_at ASC
  LIMIT $2
),
agg_result AS (
  INSERT INTO paper_trade_snapshots_daily (paper_trade_id, snapshot_day, min_price, max_price, latest_price, sample_count, latest_snapshot_at)
  SELECT ps.paper_trade_id,
         DATE(ps.captured_at AT TIME ZONE 'UTC'),
         MIN(ps.price_usd),
         MAX(ps.price_usd),
         (ARRAY_AGG(ps.price_usd ORDER BY ps.captured_at DESC) FILTER (WHERE ps.price_usd IS NOT NULL))[1],
         COUNT(*),
         MAX(ps.captured_at)
  FROM paper_trade_snapshots ps
  WHERE ps.id IN (SELECT id FROM batch_ids)
  GROUP BY ps.paper_trade_id, DATE(ps.captured_at AT TIME ZONE 'UTC')
  ON CONFLICT (paper_trade_id, snapshot_day) DO UPDATE SET
    min_price = LEAST(EXCLUDED.min_price, COALESCE(paper_trade_snapshots_daily.min_price, EXCLUDED.min_price)),
    max_price = GREATEST(EXCLUDED.max_price, COALESCE(paper_trade_snapshots_daily.max_price, EXCLUDED.max_price)),
    latest_price = EXCLUDED.latest_price,
    sample_count = paper_trade_snapshots_daily.sample_count + EXCLUDED.sample_count,
    latest_snapshot_at = GREATEST(EXCLUDED.latest_snapshot_at, paper_trade_snapshots_daily.latest_snapshot_at)
  RETURNING 1
),
del_result AS (
  DELETE FROM paper_trade_snapshots
  WHERE id IN (SELECT id FROM batch_ids)
  RETURNING 1
)
SELECT (SELECT COUNT(*) FROM batch_ids)::int AS batch_count,
       (SELECT COUNT(*) FROM del_result)::int AS deleted_count`;

let running = false;
let runs = 0;
let lastRunRowsProcessed = 0;
let lastRunRowsDeleted = 0;
let lastStartedAt: string | null = null;
let lastFinishedAt: string | null = null;
let lastError: string | null = null;

export const paperSnapshotRetentionDiag = () => ({
  enabled: !!pool,
  running,
  runs,
  rawRetentionDays: RAW_RETENTION_DAYS,
  aggregateRetentionDays: AGGREGATE_RETENTION_DAYS,
  batchSize: BATCH_SIZE,
  lastRunRowsProcessed,
  lastRunRowsDeleted,
  lastStartedAt,
  lastFinishedAt,
  lastError,
});

async function ensureAggregateTable(client: PoolClient): Promise<void> {
  await client.query(`CREATE TABLE IF NOT EXISTS paper_trade_snapshots_daily (
    paper_trade_id BIGINT NOT NULL,
    snapshot_day DATE NOT NULL,
    min_price NUMERIC,
    max_price NUMERIC,
    latest_price NUMERIC,
    sample_count INTEGER NOT NULL DEFAULT 0,
    latest_snapshot_at TIMESTAMPTZ,
    PRIMARY KEY (paper_trade_id, snapshot_day),
    CONSTRAINT fk_paper_trade FOREIGN KEY (paper_trade_id)
      REFERENCES paper_trades(id) ON DELETE CASCADE
  )`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_paper_snapshots_daily_day
    ON paper_trade_snapshots_daily(snapshot_day)`);
}

/**
 * Single atomic batch: select bounded IDs, aggregate, upsert, delete.
 * All in one transaction to prevent double-counting.
 */
async function processExpiredSnapshotBatch(client: PoolClient): Promise<{ processed: number; deleted: number }> {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - RAW_RETENTION_DAYS);

  const result = await client.query(PAPER_SNAPSHOT_RETENTION_BATCH_SQL, [cutoffDate, BATCH_SIZE]);

  const row = result.rows[0] || {};
  return {
    processed: Number(row.batch_count || 0),
    deleted: Number(row.deleted_count || 0),
  };
}

async function deleteExpiredAggregates(client: PoolClient): Promise<number> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - AGGREGATE_RETENTION_DAYS);
  const cutoffDate = cutoff.toISOString().split('T')[0];

  const result = await client.query(
    `WITH batch_ids AS (
      SELECT paper_trade_id, snapshot_day FROM paper_trade_snapshots_daily
      WHERE snapshot_day < $1
      LIMIT $2
    )
    DELETE FROM paper_trade_snapshots_daily
    WHERE (paper_trade_id, snapshot_day) IN (SELECT paper_trade_id, snapshot_day FROM batch_ids)
    `,
    [cutoffDate, BATCH_SIZE],
  );

  return result.rowCount || 0;
}

export async function runPaperSnapshotRetention(): Promise<void> {
  if (!pool || running) return;
  running = true;
  runs++;
  lastStartedAt = new Date().toISOString();
  lastError = null;
  lastRunRowsProcessed = 0;
  lastRunRowsDeleted = 0;

  let client: PoolClient | null = null;
  let locked = false;
  try {
    client = await pool.connect();
    await client.query(`SET statement_timeout = '180s'`);
    await client.query(`SET lock_timeout = '5s'`);

    const claim = await client.query(
      `SELECT pg_try_advisory_lock(hashtext('memebot-paper-snapshot-retention-v1')) AS acquired`,
    );
    locked = claim.rows[0]?.acquired === true;
    if (!locked) return;

    await ensureAggregateTable(client);

    // Process batches until none remain
    let totalProcessed = 0;
    let totalDeleted = 0;
    let iterations = 0;
    const maxIterations = 100; // Safety limit
    while (iterations < maxIterations) {
      iterations++;
      const batchResult = await processExpiredSnapshotBatch(client);
      totalProcessed += batchResult.processed;
      totalDeleted += batchResult.deleted;

      if (batchResult.processed < BATCH_SIZE) break; // Last batch was smaller, done
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    lastRunRowsProcessed = totalProcessed;
    lastRunRowsDeleted = totalDeleted;

    // Clean up expired daily aggregates
    let totalAggregatesDeleted = 0;
    iterations = 0;
    while (iterations < maxIterations) {
      iterations++;
      const deleted = await deleteExpiredAggregates(client);
      totalAggregatesDeleted += deleted;
      if (deleted < BATCH_SIZE) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    lastFinishedAt = new Date().toISOString();
    if (totalProcessed > 0 || totalAggregatesDeleted > 0) {
      console.log(
        `[paper-snapshot-retention] processed ${totalProcessed} raw snapshots, deleted ${totalDeleted} rows, cleaned ${totalAggregatesDeleted} expired aggregates`,
      );
    }
  } catch (error) {
    lastError = (error as Error).message.slice(0, 300);
    console.warn(`[paper-snapshot-retention] ${(error as Error).message}`);
  } finally {
    if (client && locked) {
      await client
        .query(`SELECT pg_advisory_unlock(hashtext('memebot-paper-snapshot-retention-v1'))`)
        .catch(() => {});
    }
    client?.release();
    running = false;
  }
}

export function startPaperSnapshotRetention(): void {
  if (!pool) return;
  const initial = setTimeout(() => void runPaperSnapshotRetention(), INITIAL_DELAY_MS);
  initial.unref();
  const timer = setInterval(() => void runPaperSnapshotRetention(), INTERVAL_MS);
  timer.unref();
}

