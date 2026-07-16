import type { PoolClient } from 'pg';
import { pool } from './db';

const LOCK_NAME = process.env.WORKER_LOCK_KEY || 'memewatch-production-worker-v1';
let lockClient: PoolClient | null = null;
let leader = false;
let lastError: string | null = null;
let attempts = 0;

export const leadershipDiag = () => ({
  role: leader ? 'leader' : 'follower',
  lockName: LOCK_NAME,
  coordinated: !!pool,
  lastError,
  attempts,
});

/**
 * Acquire a session-level PostgreSQL advisory lock. The dedicated client is kept
 * checked out for the lifetime of the worker; when the process or connection dies,
 * PostgreSQL releases the lock automatically and another deployment can take over.
 */
export async function acquireWorkerLeadership(): Promise<boolean> {
  if (leader && lockClient) return true;
  attempts++;

  if (!pool) {
    lastError = 'DATABASE_URL missing; distributed leadership unavailable';
    console.warn(`[leadership] ${lastError}`);
    leader = true;
    return true;
  }

  let client: PoolClient | null = null;
  try {
    client = await pool.connect();
    const result = await client.query(
      `SELECT pg_try_advisory_lock(hashtext($1)) AS acquired`,
      [LOCK_NAME],
    );
    if (!result.rows[0]?.acquired) {
      client.release();
      client = null;
      leader = false;
      lastError = null;
      console.warn(`[leadership] follower mode — another deployment owns ${LOCK_NAME}`);
      return false;
    }

    lockClient = client;
    client = null;
    leader = true;
    lastError = null;
    lockClient.on('error', error => {
      lastError = error.message;
      console.error('[leadership] lock connection lost; exiting for clean failover:', error.message);
      process.exit(1);
    });
    console.log(`[leadership] leader lock acquired: ${LOCK_NAME}`);
    return true;
  } catch (error) {
    if (client) client.release(true);
    lastError = (error as Error).message;
    leader = false;
    console.error(`[leadership] acquisition attempt failed: ${lastError}`);
    return false;
  }
}

export async function releaseWorkerLeadership(): Promise<void> {
  const client = lockClient;
  lockClient = null;
  leader = false;
  if (!client) return;
  try { await client.query(`SELECT pg_advisory_unlock(hashtext($1))`, [LOCK_NAME]); }
  catch {}
  client.release();
}


// ===== DOMAIN-PRIORITY YIELD PROTOCOL =====
// The public domain is bound to one Railway instance. If that instance loses the
// lock race (leadership roulette on every rolling deploy), the domain serves
// standby stubs until the next deploy. Fix: the domain-holding service sets
// LEADERSHIP_PRIORITY=primary. While waiting, a primary registers a heartbeat
// claim; a NON-primary leader that sees a fresh primary claim steps down
// gracefully (SIGTERM path — hydration flushes, lock releases, primary acquires
// within its retry loop). No lock stealing; plain cooperative yield.
export const isPrimaryInstance = () => process.env.LEADERSHIP_PRIORITY === 'primary';

export async function registerPrimaryClaim() {
  if (!pool || !isPrimaryInstance()) return;
  await pool.query(
    `INSERT INTO leadership_claims (name, claimed_at) VALUES ('primary', now())
     ON CONFLICT (name) DO UPDATE SET claimed_at = now()`).catch(() => {});
}

export async function clearPrimaryClaim() {
  if (!pool) return;
  await pool.query(`DELETE FROM leadership_claims WHERE name = 'primary'`).catch(() => {});
}

export function startYieldWatch() {
  if (!pool || isPrimaryInstance() || !leader) return;   // primaries never yield
  const timer = setInterval(async () => {
    try {
      const r = await pool!.query(
        `SELECT 1 FROM leadership_claims WHERE name = 'primary' AND claimed_at > now() - interval '90 seconds'`);
      if (r.rowCount) {
        console.log('[leadership] fresh PRIMARY claim detected — yielding leadership for the domain-holding instance');
        clearInterval(timer);
        process.kill(process.pid, 'SIGTERM');   // graceful: hydration flush runs, lock releases on exit
      }
    } catch { /* never yield on error */ }
  }, 30_000);
  timer.unref();
}
