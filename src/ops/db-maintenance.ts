import type { PoolClient } from 'pg';
import { pool } from '../db';

const TABLES = [
  'tokens',
  'outcomes',
  'paper_trades',
  'paper_trade_snapshots',
  'paper_trade_events',
  'trade_events',
  'wallet_hits',
  'smart_wallets',
  'signal_observations',
  'signal_observation_outcomes',
  'signal_decisions',
  'signal_decision_outcomes',
] as const;

const INITIAL_DELAY_MS = 45_000;
const INTERVAL_MS = 6 * 60 * 60_000;
let running = false;
let runs = 0;
let analyzed = 0;
let maintenanceObjectsReady = false;
let lastStartedAt: string | null = null;
let lastFinishedAt: string | null = null;
let lastError: string | null = null;
let lastDurationsMs: Record<string, number> = {};

export const databaseMaintenanceDiag = () => ({
  enabled: !!pool,
  running,
  runs,
  analyzed,
  maintenanceObjectsReady,
  intervalHours: INTERVAL_MS / 3_600_000,
  lastStartedAt,
  lastFinishedAt,
  lastError,
  lastDurationsMs,
});

async function ensureMaintenanceObjects(client: PoolClient) {
  // Analyze sooner than PostgreSQL defaults on the high-churn evidence tables. These
  // settings do not delete rows or rewrite historical evidence.
  for (const table of ['tokens', 'outcomes', 'paper_trades', 'paper_trade_snapshots', 'trade_events']) {
    await client.query(`ALTER TABLE ${table} SET (
      autovacuum_analyze_scale_factor = 0.01,
      autovacuum_analyze_threshold = 500,
      autovacuum_vacuum_scale_factor = 0.05,
      autovacuum_vacuum_threshold = 1000
    )`).catch(() => {});
  }

  // Entry context already preserves the full immutable feature set. Later time-series
  // snapshots keep scalar market columns and compact duplicate JSON, preventing the
  // snapshot table from continuing to grow at the previous multi-gigabyte rate.
  await client.query(`
    CREATE OR REPLACE FUNCTION memebot_compact_snapshot_json()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.bucket_seconds > 0 THEN
        IF NEW.smart_wallets IS NOT NULL THEN
          NEW.smart_wallets = NEW.smart_wallets - 'hits';
        END IF;
        IF NEW.model_decision IS NOT NULL THEN
          NEW.model_decision = NEW.model_decision - 'features' - 'hazards' - 'execution';
        END IF;
        IF NEW.entity_graph IS NOT NULL THEN
          NEW.entity_graph = NEW.entity_graph - 'details' - 'edges' - 'nodes';
        END IF;
      END IF;
      RETURN NEW;
    END;
    $$;
    DROP TRIGGER IF EXISTS trg_memebot_compact_snapshot_json ON paper_trade_snapshots;
    CREATE TRIGGER trg_memebot_compact_snapshot_json
      BEFORE INSERT ON paper_trade_snapshots
      FOR EACH ROW EXECUTE FUNCTION memebot_compact_snapshot_json();
  `);
  maintenanceObjectsReady = true;
}

export async function runDatabaseMaintenance(): Promise<void> {
  if (!pool || running) return;
  running = true;
  runs++;
  lastStartedAt = new Date().toISOString();
  lastError = null;
  const durations: Record<string, number> = {};
  let client: PoolClient | null = null;
  let locked = false;
  try {
    client = await pool.connect();
    await client.query(`SET statement_timeout = '90s'`);
    await client.query(`SET lock_timeout = '2s'`);
    const claim = await client.query(`SELECT pg_try_advisory_lock(hashtext('memebot-db-maintenance-v1')) AS acquired`);
    locked = claim.rows[0]?.acquired === true;
    if (!locked) return;

    await ensureMaintenanceObjects(client);
    for (const table of TABLES) {
      const started = Date.now();
      try {
        // Table names come exclusively from the constant allowlist above.
        await client.query(`ANALYZE ${table}`);
        analyzed++;
        durations[table] = Date.now() - started;
      } catch (error) {
        durations[table] = Date.now() - started;
        lastError = `${table}: ${(error as Error).message}`.slice(0, 300);
        console.warn(`[db-maintenance] ANALYZE ${table} skipped: ${(error as Error).message}`);
      }
      // Yield between tables so scanner queries are not monopolized by maintenance.
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    lastFinishedAt = new Date().toISOString();
    lastDurationsMs = durations;
    if (!lastError) console.log(`[db-maintenance] analyzed ${TABLES.length} tables`);
  } catch (error) {
    lastError = (error as Error).message.slice(0, 300);
    console.warn(`[db-maintenance] ${(error as Error).message}`);
  } finally {
    if (client && locked) await client.query(`SELECT pg_advisory_unlock(hashtext('memebot-db-maintenance-v1'))`).catch(() => {});
    client?.release();
    running = false;
  }
}

export function startDatabaseMaintenance() {
  if (!pool) return;
  const initial = setTimeout(() => void runDatabaseMaintenance(), INITIAL_DELAY_MS);
  initial.unref();
  const timer = setInterval(() => void runDatabaseMaintenance(), INTERVAL_MS);
  timer.unref();
}
