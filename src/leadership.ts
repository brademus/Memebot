import { pool } from './db';

const LOCK_NAME = process.env.WORKER_LOCK_KEY || 'memewatch-production-worker-v1';
const INSTANCE_ID = `${process.env.RAILWAY_REPLICA_ID || process.env.HOSTNAME || 'local'}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
let leader = false;
let lastError: string | null = null;
let attempts = 0;
let leadershipSchemaReady: Promise<void> | null = null;

export const leadershipDiag = () => ({
  role: leader ? 'leader' : 'follower',
  lockName: LOCK_NAME,
  coordinated: !!pool,
  lastError,
  attempts,
});

/**
 * Leadership is needed before the normal application boot imports index.ts and runs
 * initDb(). A fresh/replaced Railway Postgres volume therefore cannot rely on the
 * regular migration path to create this table. Keep the tiny coordination schema
 * self-bootstrapping and idempotent so worker election also works on an empty DB.
 */
export async function ensureLeadershipSchema(): Promise<void> {
  if (!pool) return;
  if (!leadershipSchemaReady) {
    leadershipSchemaReady = (async () => {
      await pool.query(
        `CREATE TABLE IF NOT EXISTS leadership_claims (
           name TEXT PRIMARY KEY,
           claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
           value TEXT
         )`,
      );
      // Existing databases may have the earlier two-column table.
      await pool.query(`ALTER TABLE leadership_claims ADD COLUMN IF NOT EXISTS value TEXT`);
    })().catch(error => {
      leadershipSchemaReady = null;
      throw error;
    });
  }
  await leadershipSchemaReady;
}

/**
 * Acquire an expiring PostgreSQL lease. The leader refreshes it every 30 seconds;
 * another worker can take over after 90 seconds without depending on a dead session
 * being noticed by PostgreSQL.
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

  try {
    await ensureLeadershipSchema();
    const r = await pool.query(
      `INSERT INTO leadership_claims (name, claimed_at, value) VALUES ('lease', now(), $1)
       ON CONFLICT (name) DO UPDATE SET claimed_at = now(), value = EXCLUDED.value
         WHERE leadership_claims.claimed_at < now() - interval '90 seconds'
            OR leadership_claims.value = EXCLUDED.value
       RETURNING value`, [INSTANCE_ID]);
    if (!r.rowCount || r.rows[0].value !== INSTANCE_ID) {
      leader = false;
      lastError = null;
      console.warn('[leadership] follower — a live lease is held by another instance');
      return false;
    }
    leader = true;
    lastError = null;
    const hb = setInterval(async () => {
      try {
        const beat = await pool!.query(
          `UPDATE leadership_claims SET claimed_at = now() WHERE name = 'lease' AND value = $1`, [INSTANCE_ID]);
        if (!beat.rowCount) {
          console.error('[leadership] lease lost (taken by another instance) — exiting for clean failover');
          process.exit(1);
        }
      } catch (error) {
        console.error('[leadership] heartbeat error:', (error as Error).message);
      }
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
  if (!pool) return;
  await ensureLeadershipSchema().catch(() => {});
  await pool.query(
    `DELETE FROM leadership_claims WHERE name = 'lease' AND value = $1`, [INSTANCE_ID],
  ).catch(() => {});
}

// ===== DOMAIN-PRIORITY YIELD PROTOCOL =====
export const isPrimaryInstance = () => process.env.LEADERSHIP_PRIORITY === 'primary';

export async function registerPrimaryClaim() {
  if (!pool || !isPrimaryInstance()) return;
  await ensureLeadershipSchema().catch(() => {});
  await pool.query(
    `INSERT INTO leadership_claims (name, claimed_at) VALUES ('primary', now())
     ON CONFLICT (name) DO UPDATE SET claimed_at = now()`,
  ).catch(() => {});
}

export async function clearPrimaryClaim() {
  if (!pool) return;
  await ensureLeadershipSchema().catch(() => {});
  await pool.query(`DELETE FROM leadership_claims WHERE name = 'primary'`).catch(() => {});
}

export function startYieldWatch() {
  if (!pool || isPrimaryInstance() || !leader) return;
  const timer = setInterval(async () => {
    try {
      const r = await pool!.query(
        `SELECT 1 FROM leadership_claims WHERE name = 'primary' AND claimed_at > now() - interval '90 seconds'`);
      if (r.rowCount) {
        console.log('[leadership] fresh PRIMARY claim detected — yielding leadership for the domain-holding instance');
        clearInterval(timer);
        process.kill(process.pid, 'SIGTERM');
      }
    } catch { /* never yield on error */ }
  }, 30_000);
  timer.unref();
}

// ===== LEADER ADDRESS PUBLICATION (for the standby reverse proxy) =====
let addrTimer: ReturnType<typeof setInterval> | null = null;
export function startLeaderAddressPublication() {
  if (!pool) return;
  const host = process.env.RAILWAY_PRIVATE_DOMAIN || null;
  if (!host) return;
  const addr = `${host}:${process.env.PORT || '8080'}`;
  const publish = async () => {
    await ensureLeadershipSchema();
    await pool!.query(
      `INSERT INTO leadership_claims (name, claimed_at, value) VALUES ('leader_addr', now(), $1)
       ON CONFLICT (name) DO UPDATE SET claimed_at = now(), value = $1`, [addr]);
  };
  void publish().catch(error => console.error('[leadership] leader address publish:', (error as Error).message));
  addrTimer = setInterval(() => {
    void publish().catch(error => console.error('[leadership] leader address publish:', (error as Error).message));
  }, 60_000);
  addrTimer.unref();
}

export async function readLeaderAddress(): Promise<string | null> {
  if (!pool) return null;
  await ensureLeadershipSchema();
  const r = await pool.query(
    `SELECT value FROM leadership_claims WHERE name = 'leader_addr' AND claimed_at > now() - interval '150 seconds'`,
  ).catch(() => ({ rows: [] as any[] }));
  return r.rows[0]?.value || null;
}
