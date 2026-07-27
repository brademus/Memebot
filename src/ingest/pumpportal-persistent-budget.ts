import { randomUUID } from 'node:crypto';
import { pool } from '../db';

// PumpPortal bills 0.01 SOL per 10,000 paid trade messages. Railway variables may
// lower these ceilings, but cannot raise them above the conservative hard limits.
export const PUMPPORTAL_DAILY_PAID_EVENT_LIMIT = Math.max(
  250,
  Math.min(4_000, Number(process.env.PUMPPORTAL_DAILY_PAID_EVENT_LIMIT || 4_000)),
);
export const PUMPPORTAL_ROLLING_14D_EVENT_LIMIT = Math.max(
  PUMPPORTAL_DAILY_PAID_EVENT_LIMIT,
  Math.min(50_000, Number(process.env.PUMPPORTAL_ROLLING_14D_EVENT_LIMIT || 50_000)),
);
export const PUMPPORTAL_RESERVATION_BLOCK_EVENTS = Math.max(
  50,
  Math.min(250, Number(process.env.PUMPPORTAL_RESERVATION_BLOCK_EVENTS || 250)),
);

const COST_SOL_PER_EVENT = 0.01 / 10_000;
const TOP_UP_THRESHOLD = Math.min(75, Math.max(10, Math.floor(PUMPPORTAL_RESERVATION_BLOCK_EVENTS / 3)));
const RETRY_MS = 60_000;
const HYSTERESIS_COOLDOWN_MS = 30_000;
const LEASE_TTL_MS = Math.max(
  2 * 60_000,
  Math.min(15 * 60_000, Number(process.env.PUMPPORTAL_RESERVATION_LEASE_MS || 5 * 60_000)),
);
const LEGACY_RESERVATION_GRACE_MS = Math.max(
  5 * 60_000,
  Math.min(30 * 60_000, Number(process.env.PUMPPORTAL_LEGACY_RESERVATION_GRACE_MS || 10 * 60_000)),
);
const PROCESS_ID = randomUUID();

type Listener = () => void;

interface PersistentBudgetState {
  initialized: boolean;
  initializing: boolean;
  databaseAvailable: boolean;
  exhausted: boolean;
  localReservedRemaining: number;
  reservedToday: number;
  reservedRolling14d: number;
  actualToday: number;
  actualRolling14d: number;
  reservationCount: number;
  pendingActualWrites: number;
  lastReservationAt: number | null;
  lastEventAt: number | null;
  lastRefreshAt: number | null;
  lastError: string | null;
  targetDailyPace: number;
  actualPaceEventsPerSec: number;
  suppressedStaleDueToResubscribeCooldown: number;
  lastSubscriptionChangeAt: number | null;
  leaseDay: string;
  leaseId: string;
  leaseExpiresAt: number | null;
  staleLeaseReclaims: number;
  legacyReservationsCleared: number;
  leaseHeartbeats: number;
}

const utcDay = () => new Date().toISOString().slice(0, 10);
const leaseIdForDay = (day: string) => `${PROCESS_ID}:${day}`;
const initialDay = utcDay();
const state: PersistentBudgetState = {
  initialized: false,
  initializing: false,
  databaseAvailable: !!pool,
  exhausted: false,
  localReservedRemaining: 0,
  reservedToday: 0,
  reservedRolling14d: 0,
  actualToday: 0,
  actualRolling14d: 0,
  reservationCount: 0,
  pendingActualWrites: 0,
  lastReservationAt: null,
  lastEventAt: null,
  lastRefreshAt: null,
  lastError: null,
  targetDailyPace: 0,
  actualPaceEventsPerSec: 0,
  suppressedStaleDueToResubscribeCooldown: 0,
  lastSubscriptionChangeAt: null,
  leaseDay: initialDay,
  leaseId: leaseIdForDay(initialDay),
  leaseExpiresAt: null,
  staleLeaseReclaims: 0,
  legacyReservationsCleared: 0,
  leaseHeartbeats: 0,
};

const listeners = new Set<Listener>();
let initializationPromise: Promise<void> | null = null;
let reservationInFlight: Promise<boolean> | null = null;
let actualWriteInFlight: Promise<void> | null = null;
let shutdownStarted = false;

const iso = (value: number | null) => (value ? new Date(value).toISOString() : null);
const cost = (events: number) => Number((Math.max(0, events) * COST_SOL_PER_EVENT).toFixed(6));

function computeTargetPace(): number {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setUTCHours(24, 0, 0, 0);
  const secondsRemaining = Math.max(0, midnight.getTime() - now.getTime()) / 1000;
  return secondsRemaining > 0 ? PUMPPORTAL_DAILY_PAID_EVENT_LIMIT / secondsRemaining : 0;
}

// Never move a buffered event into a different UTC day. At midnight the stream pauses
// briefly, flushes the old-day batch, then acquires a fresh lease for the new day.
function rollLeaseDayIfNeeded(): boolean {
  const day = utcDay();
  if (day === state.leaseDay) return true;
  if (state.pendingActualWrites > 0 || actualWriteInFlight) {
    void flushActualEvents();
    return false;
  }
  state.leaseDay = day;
  state.leaseId = leaseIdForDay(day);
  state.leaseExpiresAt = null;
  state.localReservedRemaining = 0;
  state.reservedToday = 0;
  state.actualToday = 0;
  state.exhausted = false;
  return true;
}

async function ensureTables(): Promise<void> {
  if (!pool) throw new Error('DATABASE_URL unavailable; paid PumpPortal stream is fail-closed');
  await pool.query(`CREATE TABLE IF NOT EXISTS pumpportal_paid_usage (
    usage_day DATE PRIMARY KEY,
    reserved_events INTEGER NOT NULL DEFAULT 0 CHECK (reserved_events >= 0),
    actual_events INTEGER NOT NULL DEFAULT 0 CHECK (actual_events >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS pumpportal_paid_leases (
    lease_id TEXT PRIMARY KEY,
    usage_day DATE NOT NULL,
    reserved_events INTEGER NOT NULL DEFAULT 0 CHECK (reserved_events >= 0),
    consumed_events INTEGER NOT NULL DEFAULT 0 CHECK (consumed_events >= 0),
    expires_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS pumpportal_paid_leases_day_expiry_idx
    ON pumpportal_paid_leases (usage_day, expires_at)`);
}

async function cleanupExpiredLeases(client: any = pool): Promise<number> {
  if (!client) return 0;
  const result = await client.query(`DELETE FROM pumpportal_paid_leases
    WHERE expires_at<=now() RETURNING lease_id`);
  const count = Number(result.rowCount || 0);
  state.staleLeaseReclaims += count;
  return count;
}

// V1 stored process-local allowance permanently in pumpportal_paid_usage.reserved_events.
// Preserve a recently updated row during a mixed-version rolling deploy, but reclaim it
// after the old process has had ample time to stop. The shared v1 advisory lock prevents
// old and new writers from allocating the same capacity during this transition.
async function cleanupStaleLegacyReservations(client: any): Promise<number> {
  const result = await client.query(`UPDATE pumpportal_paid_usage SET
      reserved_events=actual_events,updated_at=now()
    WHERE reserved_events>actual_events
      AND updated_at<now()-($1::text||' milliseconds')::interval
    RETURNING usage_day`, [LEGACY_RESERVATION_GRACE_MS]);
  const count = Number(result.rowCount || 0);
  state.legacyReservationsCleared += count;
  return count;
}

const totalsSql = `SELECT
  COALESCE((SELECT SUM(actual_events) FROM pumpportal_paid_usage
    WHERE usage_day=CURRENT_DATE),0)::int AS actual_today,
  COALESCE((SELECT SUM(actual_events) FROM pumpportal_paid_usage
    WHERE usage_day>=CURRENT_DATE-13),0)::int AS actual_14d,
  COALESCE((SELECT SUM(GREATEST(reserved_events-actual_events,0))
    FROM pumpportal_paid_usage
    WHERE usage_day=CURRENT_DATE
      AND updated_at>=now()-($1::text||' milliseconds')::interval),0)::int AS legacy_today,
  COALESCE((SELECT SUM(GREATEST(reserved_events-actual_events,0))
    FROM pumpportal_paid_usage
    WHERE usage_day>=CURRENT_DATE-13
      AND updated_at>=now()-($1::text||' milliseconds')::interval),0)::int AS legacy_14d,
  COALESCE((SELECT SUM(GREATEST(reserved_events-consumed_events,0))
    FROM pumpportal_paid_leases WHERE usage_day=CURRENT_DATE AND expires_at>now()),0)::int AS outstanding_today,
  COALESCE((SELECT SUM(GREATEST(reserved_events-consumed_events,0))
    FROM pumpportal_paid_leases WHERE usage_day>=CURRENT_DATE-13 AND expires_at>now()),0)::int AS outstanding_14d`;

async function refreshTotals(): Promise<void> {
  if (!pool) return;
  await cleanupExpiredLeases();
  const result = await pool.query(totalsSql, [LEGACY_RESERVATION_GRACE_MS]);
  const row = result.rows[0] || {};
  state.actualToday = Number(row.actual_today || 0);
  state.actualRolling14d = Number(row.actual_14d || 0);
  state.reservedToday = state.actualToday + Number(row.legacy_today || 0) + Number(row.outstanding_today || 0);
  state.reservedRolling14d = state.actualRolling14d + Number(row.legacy_14d || 0) + Number(row.outstanding_14d || 0);
  state.lastRefreshAt = Date.now();
  state.targetDailyPace = computeTargetPace();
}

function initialize(): Promise<void> {
  if (state.initialized) return Promise.resolve();
  if (initializationPromise) return initializationPromise;
  state.initializing = true;
  initializationPromise = (async () => {
    try {
      await ensureTables();
      await refreshTotals();
      state.initialized = true;
      state.databaseAvailable = true;
      state.lastError = null;
    } catch (error) {
      state.databaseAvailable = false;
      state.lastError = (error as Error).message.slice(0, 300);
    } finally {
      state.initializing = false;
      initializationPromise = null;
    }
  })();
  return initializationPromise;
}

async function reserveBlock(): Promise<boolean> {
  await initialize();
  if (!rollLeaseDayIfNeeded()) return false;
  if (!pool || !state.databaseAvailable) return false;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('memebot-pumpportal-paid-budget-v1'))`);
    await cleanupExpiredLeases(client);
    await cleanupStaleLegacyReservations(client);
    const totals = await client.query(totalsSql, [LEGACY_RESERVATION_GRACE_MS]);
    const row = totals.rows[0] || {};
    const actualToday = Number(row.actual_today || 0);
    const actual14d = Number(row.actual_14d || 0);
    const legacyToday = Number(row.legacy_today || 0);
    const legacy14d = Number(row.legacy_14d || 0);
    const outstandingToday = Number(row.outstanding_today || 0);
    const outstanding14d = Number(row.outstanding_14d || 0);
    const grant = Math.min(
      PUMPPORTAL_RESERVATION_BLOCK_EVENTS,
      Math.max(0, PUMPPORTAL_DAILY_PAID_EVENT_LIMIT - actualToday - legacyToday - outstandingToday),
      Math.max(0, PUMPPORTAL_ROLLING_14D_EVENT_LIMIT - actual14d - legacy14d - outstanding14d),
    );
    if (grant <= 0) {
      await client.query('COMMIT');
      state.actualToday = actualToday;
      state.actualRolling14d = actual14d;
      state.reservedToday = actualToday + legacyToday + outstandingToday;
      state.reservedRolling14d = actual14d + legacy14d + outstanding14d;
      state.exhausted = state.localReservedRemaining <= 0;
      state.lastRefreshAt = Date.now();
      return false;
    }

    await client.query(`INSERT INTO pumpportal_paid_leases
      (lease_id,usage_day,reserved_events,consumed_events,expires_at,updated_at)
      VALUES ($1,$2::date,$3,0,now()+($4::text||' milliseconds')::interval,now())
      ON CONFLICT (lease_id) DO UPDATE SET
        usage_day=EXCLUDED.usage_day,
        reserved_events=pumpportal_paid_leases.reserved_events+EXCLUDED.reserved_events,
        expires_at=EXCLUDED.expires_at,updated_at=now()`,
    [state.leaseId, state.leaseDay, grant, LEASE_TTL_MS]);
    await client.query('COMMIT');

    state.localReservedRemaining += grant;
    state.actualToday = actualToday;
    state.actualRolling14d = actual14d;
    state.reservedToday = actualToday + legacyToday + outstandingToday + grant;
    state.reservedRolling14d = actual14d + legacy14d + outstanding14d + grant;
    state.reservationCount++;
    state.lastReservationAt = Date.now();
    state.lastRefreshAt = Date.now();
    state.leaseExpiresAt = Date.now() + LEASE_TTL_MS;
    state.exhausted = false;
    state.lastError = null;
    for (const listener of listeners) listener();
    return true;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    state.lastError = (error as Error).message.slice(0, 300);
    return false;
  } finally {
    client.release();
  }
}

function requestReservation(): Promise<boolean> {
  if (reservationInFlight) return reservationInFlight;
  reservationInFlight = reserveBlock().finally(() => { reservationInFlight = null; });
  return reservationInFlight;
}

async function flushActualEvents(): Promise<void> {
  if (!pool || state.pendingActualWrites <= 0 || actualWriteInFlight) return;
  const count = state.pendingActualWrites;
  const usageDay = state.leaseDay;
  const leaseId = state.leaseId;
  state.pendingActualWrites = 0;
  actualWriteInFlight = (async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO pumpportal_paid_usage
        (usage_day,reserved_events,actual_events,updated_at)
        VALUES ($1::date,$2,$2,now())
        ON CONFLICT (usage_day) DO UPDATE SET
          actual_events=pumpportal_paid_usage.actual_events+EXCLUDED.actual_events,
          reserved_events=GREATEST(
            pumpportal_paid_usage.actual_events+EXCLUDED.actual_events,
            pumpportal_paid_usage.reserved_events
          ),updated_at=now()`, [usageDay, count]);
      await client.query(`UPDATE pumpportal_paid_leases SET
        consumed_events=LEAST(reserved_events,consumed_events+$2),
        expires_at=now()+($3::text||' milliseconds')::interval,updated_at=now()
        WHERE lease_id=$1`, [leaseId, count, LEASE_TTL_MS]);
      await client.query('COMMIT');
      state.actualToday += count;
      state.actualRolling14d += count;
      state.leaseExpiresAt = Date.now() + LEASE_TTL_MS;
      state.lastError = null;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      state.pendingActualWrites += count;
      state.lastError = (error as Error).message.slice(0, 300);
    } finally {
      client.release();
    }
  })().finally(() => { actualWriteInFlight = null; });
  await actualWriteInFlight;
}

async function heartbeatLease(): Promise<void> {
  if (!pool || state.localReservedRemaining <= 0) return;
  try {
    const result = await pool.query(`UPDATE pumpportal_paid_leases SET
      expires_at=now()+($2::text||' milliseconds')::interval,updated_at=now()
      WHERE lease_id=$1 AND expires_at>now()`, [state.leaseId, LEASE_TTL_MS]);
    if (!result.rowCount) {
      state.localReservedRemaining = 0;
      state.leaseExpiresAt = null;
      void requestReservation();
      return;
    }
    state.leaseExpiresAt = Date.now() + LEASE_TTL_MS;
    state.leaseHeartbeats++;
    state.lastError = null;
  } catch (error) {
    state.lastError = (error as Error).message.slice(0, 300);
    // The in-memory allowance cannot outlive its database lease.
    if (!state.leaseExpiresAt || state.leaseExpiresAt <= Date.now()) {
      state.localReservedRemaining = 0;
      state.exhausted = true;
    }
  }
}

export function ensurePumpPortalPersistentBudget(): void {
  void initialize().then(() => {
    if (state.localReservedRemaining <= TOP_UP_THRESHOLD) void requestReservation();
  });
}

export function paidStreamBudgetAvailable(): boolean {
  if (!rollLeaseDayIfNeeded()) return false;
  if (!state.leaseExpiresAt || state.leaseExpiresAt <= Date.now()) {
    state.localReservedRemaining = 0;
    state.exhausted = true;
    void requestReservation();
    return false;
  }
  return state.databaseAvailable && state.localReservedRemaining > 0;
}

export function consumePersistentPaidEvent(): boolean {
  state.lastEventAt = Date.now();
  if (!paidStreamBudgetAvailable()) return false;
  state.localReservedRemaining--;
  state.exhausted = state.localReservedRemaining <= 0;
  state.pendingActualWrites++;
  if (state.pendingActualWrites >= 25) void flushActualEvents();
  if (state.localReservedRemaining <= TOP_UP_THRESHOLD) void requestReservation();
  return true;
}

export function onPumpPortalBudgetAvailable(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function notifySubscriptionChange(): void {
  state.lastSubscriptionChangeAt = Date.now();
}

export function canResubscribeAfterCooldown(): boolean {
  if (!state.lastSubscriptionChangeAt) return true;
  return Date.now() - state.lastSubscriptionChangeAt >= HYSTERESIS_COOLDOWN_MS;
}

export function suppressedStaleResubscriptionsIncrement(): void {
  state.suppressedStaleDueToResubscribeCooldown++;
}

export function pumpPortalPersistentBudgetDiag() {
  return {
    persistent: true,
    failClosedWithoutDatabase: true,
    reservationModel: 'expiring_process_lease',
    reservationLeaseSeconds: Math.round(LEASE_TTL_MS / 1000),
    legacyReservationGraceSeconds: Math.round(LEGACY_RESERVATION_GRACE_MS / 1000),
    legacyReservationLeakProtected: true,
    dailyEventLimit: PUMPPORTAL_DAILY_PAID_EVENT_LIMIT,
    rolling14dEventLimit: PUMPPORTAL_ROLLING_14D_EVENT_LIMIT,
    reservationBlockEvents: PUMPPORTAL_RESERVATION_BLOCK_EVENTS,
    maxDailyCostSol: cost(PUMPPORTAL_DAILY_PAID_EVENT_LIMIT),
    maxRolling14dCostSol: cost(PUMPPORTAL_ROLLING_14D_EVENT_LIMIT),
    initialized: state.initialized,
    initializing: state.initializing,
    databaseAvailable: state.databaseAvailable,
    available: paidStreamBudgetAvailable(),
    exhausted: state.exhausted,
    localReservedRemaining: state.localReservedRemaining,
    reservedToday: state.reservedToday,
    reservedRolling14d: state.reservedRolling14d,
    actualToday: state.actualToday + state.pendingActualWrites,
    actualRolling14d: state.actualRolling14d + state.pendingActualWrites,
    estimatedActualCostTodaySol: cost(state.actualToday + state.pendingActualWrites),
    estimatedActualCostRolling14dSol: cost(state.actualRolling14d + state.pendingActualWrites),
    reservationCount: state.reservationCount,
    staleLeaseReclaims: state.staleLeaseReclaims,
    legacyReservationsCleared: state.legacyReservationsCleared,
    leaseHeartbeats: state.leaseHeartbeats,
    leaseExpiresAt: iso(state.leaseExpiresAt),
    targetDailyPaceEventsPerSecond: Number(state.targetDailyPace.toFixed(3)),
    suppressedStaleDueToResubscribeCooldown: state.suppressedStaleDueToResubscribeCooldown,
    lastSubscriptionChangeAt: iso(state.lastSubscriptionChangeAt),
    lastReservationAt: iso(state.lastReservationAt),
    lastEventAt: iso(state.lastEventAt),
    lastRefreshAt: iso(state.lastRefreshAt),
    lastError: state.lastError,
  };
}

async function releaseLease(): Promise<void> {
  if (!pool) return;
  await flushActualEvents();
  await pool.query(`DELETE FROM pumpportal_paid_leases WHERE lease_id=$1`, [state.leaseId]).catch(() => {});
  state.localReservedRemaining = 0;
  state.leaseExpiresAt = null;
}

function beginShutdown() {
  if (shutdownStarted) return;
  shutdownStarted = true;
  void releaseLease();
}

ensurePumpPortalPersistentBudget();
const retryTimer = setInterval(() => {
  const dayReady = rollLeaseDayIfNeeded();
  if (state.pendingActualWrites > 0) void flushActualEvents();
  if (dayReady && state.localReservedRemaining > 0) void heartbeatLease();
  if (dayReady && state.localReservedRemaining <= TOP_UP_THRESHOLD) void requestReservation();
  state.targetDailyPace = computeTargetPace();
}, RETRY_MS);
retryTimer.unref();

process.once('beforeExit', beginShutdown);
process.once('SIGTERM', beginShutdown);
process.once('SIGINT', beginShutdown);
