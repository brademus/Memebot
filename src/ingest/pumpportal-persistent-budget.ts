import { pool } from '../db';

// PumpPortal bills 0.01 SOL per 10,000 paid trade messages. These hard ceilings
// are deliberately conservative for the current privately funded test wallet.
// Railway variables may lower the limits, but cannot raise them.
export const PUMPPORTAL_DAILY_PAID_EVENT_LIMIT = Math.max(250, Math.min(4_000,
  Number(process.env.PUMPPORTAL_DAILY_PAID_EVENT_LIMIT || 4_000)));
export const PUMPPORTAL_ROLLING_14D_EVENT_LIMIT = Math.max(
  PUMPPORTAL_DAILY_PAID_EVENT_LIMIT,
  Math.min(50_000, Number(process.env.PUMPPORTAL_ROLLING_14D_EVENT_LIMIT || 50_000)),
);
export const PUMPPORTAL_RESERVATION_BLOCK_EVENTS = Math.max(50, Math.min(250,
  Number(process.env.PUMPPORTAL_RESERVATION_BLOCK_EVENTS || 250)));

const COST_SOL_PER_EVENT = 0.01 / 10_000;
const TOP_UP_THRESHOLD = Math.min(75, Math.max(10, Math.floor(PUMPPORTAL_RESERVATION_BLOCK_EVENTS / 3)));
const RETRY_MS = 60_000;

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
}

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
};

const listeners = new Set<Listener>();
let initializationPromise: Promise<void> | null = null;
let reservationInFlight: Promise<boolean> | null = null;
let actualWriteInFlight: Promise<void> | null = null;

const iso = (value: number | null) => value ? new Date(value).toISOString() : null;
const cost = (events: number) => Number((Math.max(0, events) * COST_SOL_PER_EVENT).toFixed(6));

async function ensureTable(): Promise<void> {
  if (!pool) throw new Error('DATABASE_URL unavailable; paid PumpPortal stream is fail-closed');
  await pool.query(`CREATE TABLE IF NOT EXISTS pumpportal_paid_usage (
    usage_day DATE PRIMARY KEY,
    reserved_events INTEGER NOT NULL DEFAULT 0 CHECK (reserved_events >= 0),
    actual_events INTEGER NOT NULL DEFAULT 0 CHECK (actual_events >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
}

async function refreshTotals(): Promise<void> {
  if (!pool) return;
  const result = await pool.query(`SELECT
    COALESCE(SUM(reserved_events) FILTER (WHERE usage_day=CURRENT_DATE),0)::int AS reserved_today,
    COALESCE(SUM(reserved_events) FILTER (WHERE usage_day>=CURRENT_DATE-13),0)::int AS reserved_14d,
    COALESCE(SUM(actual_events) FILTER (WHERE usage_day=CURRENT_DATE),0)::int AS actual_today,
    COALESCE(SUM(actual_events) FILTER (WHERE usage_day>=CURRENT_DATE-13),0)::int AS actual_14d
    FROM pumpportal_paid_usage`);
  const row = result.rows[0] || {};
  state.reservedToday = Number(row.reserved_today || 0);
  state.reservedRolling14d = Number(row.reserved_14d || 0);
  state.actualToday = Number(row.actual_today || 0);
  state.actualRolling14d = Number(row.actual_14d || 0);
  state.lastRefreshAt = Date.now();
}

function initialize(): Promise<void> {
  if (state.initialized) return Promise.resolve();
  if (initializationPromise) return initializationPromise;
  state.initializing = true;
  initializationPromise = (async () => {
    try {
      await ensureTable();
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
  if (!pool || !state.databaseAvailable) return false;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('memebot-pumpportal-paid-budget-v1'))`);
    const totals = await client.query(`SELECT
      COALESCE(SUM(reserved_events) FILTER (WHERE usage_day=CURRENT_DATE),0)::int AS reserved_today,
      COALESCE(SUM(reserved_events) FILTER (WHERE usage_day>=CURRENT_DATE-13),0)::int AS reserved_14d,
      COALESCE(SUM(actual_events) FILTER (WHERE usage_day=CURRENT_DATE),0)::int AS actual_today,
      COALESCE(SUM(actual_events) FILTER (WHERE usage_day>=CURRENT_DATE-13),0)::int AS actual_14d
      FROM pumpportal_paid_usage`);
    const row = totals.rows[0] || {};
    const reservedToday = Number(row.reserved_today || 0);
    const reserved14d = Number(row.reserved_14d || 0);
    const grant = Math.min(
      PUMPPORTAL_RESERVATION_BLOCK_EVENTS,
      Math.max(0, PUMPPORTAL_DAILY_PAID_EVENT_LIMIT - reservedToday),
      Math.max(0, PUMPPORTAL_ROLLING_14D_EVENT_LIMIT - reserved14d),
    );
    if (grant <= 0) {
      await client.query('COMMIT');
      state.reservedToday = reservedToday;
      state.reservedRolling14d = reserved14d;
      state.actualToday = Number(row.actual_today || 0);
      state.actualRolling14d = Number(row.actual_14d || 0);
      state.exhausted = state.localReservedRemaining <= 0;
      state.lastRefreshAt = Date.now();
      return false;
    }
    await client.query(`INSERT INTO pumpportal_paid_usage (usage_day,reserved_events,actual_events,updated_at)
      VALUES (CURRENT_DATE,$1,0,now())
      ON CONFLICT (usage_day) DO UPDATE SET
        reserved_events=pumpportal_paid_usage.reserved_events+EXCLUDED.reserved_events,
        updated_at=now()`, [grant]);
    await client.query('COMMIT');
    state.localReservedRemaining += grant;
    state.reservedToday = reservedToday + grant;
    state.reservedRolling14d = reserved14d + grant;
    state.actualToday = Number(row.actual_today || 0);
    state.actualRolling14d = Number(row.actual_14d || 0);
    state.reservationCount++;
    state.lastReservationAt = Date.now();
    state.lastRefreshAt = Date.now();
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
  state.pendingActualWrites = 0;
  actualWriteInFlight = pool.query(`INSERT INTO pumpportal_paid_usage (usage_day,reserved_events,actual_events,updated_at)
    VALUES (CURRENT_DATE,0,$1,now())
    ON CONFLICT (usage_day) DO UPDATE SET
      actual_events=pumpportal_paid_usage.actual_events+EXCLUDED.actual_events,
      updated_at=now()`, [count])
    .then(() => {
      state.actualToday += count;
      state.actualRolling14d += count;
      state.lastError = null;
    })
    .catch(error => {
      state.pendingActualWrites += count;
      state.lastError = (error as Error).message.slice(0, 300);
    })
    .finally(() => { actualWriteInFlight = null; });
  await actualWriteInFlight;
}

export function ensurePumpPortalPersistentBudget(): void {
  void initialize().then(() => {
    if (state.localReservedRemaining <= TOP_UP_THRESHOLD) void requestReservation();
  });
}

export function paidStreamBudgetAvailable(): boolean {
  return state.databaseAvailable && state.localReservedRemaining > 0;
}

export function consumePersistentPaidEvent(): boolean {
  state.lastEventAt = Date.now();
  if (state.localReservedRemaining <= 0) {
    state.exhausted = true;
    void requestReservation();
    return false;
  }
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

export function pumpPortalPersistentBudgetDiag() {
  return {
    persistent: true,
    failClosedWithoutDatabase: true,
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
    lastReservationAt: iso(state.lastReservationAt),
    lastEventAt: iso(state.lastEventAt),
    lastRefreshAt: iso(state.lastRefreshAt),
    lastError: state.lastError,
  };
}

ensurePumpPortalPersistentBudget();
const retryTimer = setInterval(() => {
  if (state.localReservedRemaining <= TOP_UP_THRESHOLD) void requestReservation();
  if (state.pendingActualWrites > 0) void flushActualEvents();
}, RETRY_MS);
retryTimer.unref();

process.once('beforeExit', () => { void flushActualEvents(); });
