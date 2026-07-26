import { pool } from './db';

const LOCK_NAME = process.env.WORKER_LOCK_KEY || 'memewatch-production-worker-v1';
const DEPLOYMENT_ID = process.env.RAILWAY_DEPLOYMENT_ID
  || process.env.RAILWAY_GIT_COMMIT_SHA
  || process.env.RAILWAY_REPLICA_ID
  || process.env.HOSTNAME
  || `local-${process.pid}`;
const INSTANCE_ID = `${DEPLOYMENT_ID}:${process.env.RAILWAY_REPLICA_ID || process.env.HOSTNAME || 'local'}:${process.pid}:${Math.random().toString(36).slice(2, 8)}`;
let leader = false;
let lastError: string | null = null;
let attempts = 0;
let takeoverRequestedAt: string | null = null;
let lastYieldAt: string | null = null;
let leadershipSchemaReady: Promise<void> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let yieldTimer: ReturnType<typeof setInterval> | null = null;

export const leadershipDiag = () => ({
  role: leader ? 'leader' : 'follower',
  lockName: LOCK_NAME,
  deploymentId: DEPLOYMENT_ID,
  instanceId: INSTANCE_ID,
  coordinated: !!pool,
  lastError,
  attempts,
  takeoverRequestedAt,
  lastYieldAt,
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
      await pool.query(`ALTER TABLE leadership_claims ADD COLUMN IF NOT EXISTS value TEXT`);
    })().catch(error => {
      leadershipSchemaReady = null;
      throw error;
    });
  }
  await leadershipSchemaReady;
}

/**
 * Acquire an expiring PostgreSQL lease. The active worker refreshes every 30 seconds;
 * the expiry remains a final crash-recovery fallback. Normal Railway deployments use
 * the explicit deployment takeover protocol below and release immediately.
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
      console.warn('[leadership] follower — a live lease is held by another deployment');
      return false;
    }

    leader = true;
    lastError = null;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(async () => {
      try {
        const beat = await pool!.query(
          `UPDATE leadership_claims SET claimed_at = now() WHERE name = 'lease' AND value = $1`, [INSTANCE_ID]);
        if (!beat.rowCount) {
          console.error('[leadership] lease lost — exiting for clean failover');
          process.exit(1);
        }
      } catch (error) {
        console.error('[leadership] heartbeat error:', (error as Error).message);
      }
    }, 30_000);
    heartbeatTimer.unref();
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
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (!pool) return;
  await ensureLeadershipSchema().catch(() => {});
  await pool.query(
    `DELETE FROM leadership_claims WHERE name = 'lease' AND value = $1`, [INSTANCE_ID],
  ).catch(() => {});
}

/**
 * A replacement deployment records its deployment ID while waiting. All replicas from
 * the same deployment share the same value, so they never force each other to churn.
 * A leader from an older deployment sees the different value and yields immediately.
 */
export async function registerPrimaryClaim() {
  if (!pool || leader) return;
  await ensureLeadershipSchema().catch(() => {});
  await pool.query(
    `INSERT INTO leadership_claims (name, claimed_at, value) VALUES ('primary', now(), $1)
     ON CONFLICT (name) DO UPDATE SET claimed_at = now(), value = EXCLUDED.value`,
    [DEPLOYMENT_ID],
  ).then(() => {
    takeoverRequestedAt = new Date().toISOString();
  }).catch(error => {
    lastError = `takeover claim: ${(error as Error).message}`;
  });
}

export async function clearPrimaryClaim() {
  if (!pool) return;
  await ensureLeadershipSchema().catch(() => {});
  await pool.query(
    `DELETE FROM leadership_claims
      WHERE name = 'primary'
        AND (value = $1 OR value IS NULL OR claimed_at < now() - interval '90 seconds')`,
    [DEPLOYMENT_ID],
  ).catch(() => {});
}

export function startYieldWatch() {
  if (!pool || !leader || yieldTimer) return;
  const check = async () => {
    try {
      const r = await pool!.query(
        `SELECT value FROM leadership_claims
          WHERE name = 'primary'
            AND value IS NOT NULL
            AND value IS DISTINCT FROM $1
            AND claimed_at > now() - interval '90 seconds'`,
        [DEPLOYMENT_ID],
      );
      if (!r.rowCount) return;

      lastYieldAt = new Date().toISOString();
      console.log(`[leadership] replacement deployment ${r.rows[0].value} requested takeover — releasing worker lease`);
      if (yieldTimer) {
        clearInterval(yieldTimer);
        yieldTimer = null;
      }
      await releaseWorkerLeadership();
      process.exit(0);
    } catch (error) {
      lastError = `yield watch: ${(error as Error).message}`;
    }
  };

  void check();
  yieldTimer = setInterval(() => void check(), 3_000);
  yieldTimer.unref();
}

// Retained for compatibility with older diagnostics; takeover is now automatic.
export const isPrimaryInstance = () => process.env.LEADERSHIP_PRIORITY === 'primary';

// ===== LEADER ADDRESS PUBLICATION (diagnostics only) =====
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
