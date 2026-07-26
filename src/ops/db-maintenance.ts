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
let lastStartedAt: string | null = null;
let lastFinishedAt: string | null = null;
let lastError: string | null = null;
let lastDurationsMs: Record<string, number> = {};

export const databaseMaintenanceDiag = () => ({
  enabled: !!pool,
  running,
  runs,
  analyzed,
  intervalHours: INTERVAL_MS / 3_600_000,
  lastStartedAt,
  lastFinishedAt,
  lastError,
  lastDurationsMs,
});

export async function runDatabaseMaintenance(): Promise<void> {
  if (!pool || running) return;
  running = true;
  runs++;
  lastStartedAt = new Date().toISOString();
  const durations: Record<string, number> = {};
  let client: Awaited<ReturnType<typeof pool.connect>> | null = null;
  let locked = false;
  try {
    client = await pool.connect();
    await client.query(`SET statement_timeout = '90s'`);
    await client.query(`SET lock_timeout = '2s'`);
    const claim = await client.query(`SELECT pg_try_advisory_lock(hashtext('memebot-db-maintenance-v1')) AS acquired`);
    locked = claim.rows[0]?.acquired === true;
    if (!locked) return;

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
