import { pool } from './db';

const LOCK_NAME = process.env.WORKER_LOCK_KEY || 'memewatch-production-worker-v1';
const INSTANCE_ID = `${process.env.RAILWAY_REPLICA_ID || process.env.HOSTNAME || 'local'}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
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
  if (leader) return true;
  attempts++;

  if (!pool) {
    lastError = 'DATABASE_URL missing; distributed leadership unavailable';
    console.warn(`[leadership] ${lastError}`);
    leader = true;
    return true;
  }

  // LEASE-BASED leadership (replaces the session advisory lock). The advisory lock
  // had a fatal flaw seen live: a hard-killed container's session can linger on the
  // Postgres server, holding the lock as a ZOMBIE — every new instance then waits
  // forever, the scanner is down, and nothing self-heals. A lease cannot zombie:
  // the leader heartbeats claimed_at every 30s; acquisition succeeds only if the
  // existing lease is EXPIRED (>90s stale) or already ours. Max stall after any
  // crash: 90 seconds, then leadership transfers automatically.
  try {
    const r = await pool.query(
      `INSERT INTO leadership_claims (name, claimed_at, value) VALUES ('lease', now(), $1)
       ON CONFLICT (name) DO UPDATE SET claimed_at = now(), value = EXCLUDED.value
         WHERE leadership_claims.claimed_at < now() - interval '90 seconds'
            OR leadership_claims.value = EXCLUDED.value
       RETURNING value`, [INSTANCE_ID]);
    if (!r.rowCount || r.rows[0].value !== INSTANCE_ID) {
      leader = false;
      lastError = null;
      console.warn(`[leadership] follower — a live lease is held by another instance`);
      return false;
    }
    leader = true;
    lastError = null;
    // heartbeat keeps the lease alive; a failed heartbeat means we may have lost
    // leadership (another instance can take an expired lease) — exit for a clean
    // restart rather than risk two scanners.
    const hb = setInterval(async () => {
      try {
        const beat = await pool!.query(
          `UPDATE leadership_claims SET claimed_at = now() WHERE name = 'lease' AND value = $1`, [INSTANCE_ID]);
        if (!beat.rowCount) {
          console.error('[leadership] lease lost (taken by another instance) — exiting for clean failover');
          process.exit(1);
        }
      } catch (e) { console.error('[leadership] heartbeat error:', (e as Error).message); }
    }, 30_000);
    hb.unref();
    console.log(`[leadership] lease acquired: ${LOCK_NAME} as ${INSTANCE_ID}`);
    return true;
  } catch (error) {
    lastError = (error as Error).message;
    leader = false;
    console.error(`[leadership] acquisition attempt failed: ${lastError}`);
    return false;
  }
}

export async function releaseWorkerLeadership() {
  leader = false;
  if (pool) await pool.query(`DELETE FROM leadership_claims WHERE name = 'lease'`).catch(() => {});
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


// ===== LEADER ADDRESS PUBLICATION (for the standby reverse proxy) =====
// The leader publishes its Railway-private address to Postgres on a 60s heartbeat.
// The standby proxies incoming traffic to it, so the public domain serves the REAL
// dashboard regardless of which instance won the lock — no env configuration needed.
let addrTimer: ReturnType<typeof setInterval> | null = null;
export function startLeaderAddressPublication() {
  if (!pool) return;
  const host = process.env.RAILWAY_PRIVATE_DOMAIN || null;
  if (!host) return;   // not on Railway (local dev) — standby stub remains the fallback
  const addr = `${host}:${process.env.PORT || '8080'}`;
  const publish = () => pool!.query(
    `INSERT INTO leadership_claims (name, claimed_at, value) VALUES ('leader_addr', now(), $1)
     ON CONFLICT (name) DO UPDATE SET claimed_at = now(), value = $1`, [addr]).catch(() => {});
  publish();
  addrTimer = setInterval(publish, 60_000);
  addrTimer.unref();
}

export async function readLeaderAddress(): Promise<string | null> {
  if (!pool) return null;
  const r = await pool.query(
    `SELECT value FROM leadership_claims WHERE name = 'leader_addr' AND claimed_at > now() - interval '150 seconds'`)
    .catch(() => ({ rows: [] as any[] }));
  return r.rows[0]?.value || null;
}
