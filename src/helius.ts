import { env } from './config';

export type HeliusPriority = 'fg' | 'bg';
export type HeliusRateGroup = 'enhanced' | 'rpc' | 'admin';

export interface HeliusResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
  error: string | null;
  skipped?: boolean;
}

export interface HeliusRequestOptions {
  group?: HeliusRateGroup;
  priority?: HeliusPriority;
  timeoutMs?: number;
  maxAttempts?: number;
  dedupeKey?: string;
  cacheTtlMs?: number;
}

interface Waiter {
  resolve: (granted: boolean) => void;
  enqueuedAt: number;
}

interface RateBucket {
  name: HeliusRateGroup;
  rps: number;
  burst: number;
  tokens: number;
  lastRefill: number;
  fg: Waiter[];
  bg: Waiter[];
  blockedUntil: number;
  consecutive429: number;
  last429At: number | null;
  last429Message: string | null;
}

const safeRate = (value: string | undefined, fallback: number, maximum: number) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(1, Math.min(maximum, Math.floor(parsed)));
};

// Safe defaults match the lowest standard Helius limits: Enhanced APIs at 2 RPS,
// RPC at 10 RPS, and Admin calls below their 5 RPS ceiling. Higher-plan projects
// can raise these explicitly in Railway without changing code.
const ENHANCED_RPS = safeRate(process.env.HELIUS_ENHANCED_RPS, 2, 100);
const RPC_RPS = safeRate(process.env.HELIUS_RPC_RPS, 10, 500);
const ADMIN_RPS = safeRate(process.env.HELIUS_ADMIN_RPS, 2, 5);
const MAX_BG_QUEUE = 180;

const makeBucket = (name: HeliusRateGroup, rps: number): RateBucket => ({
  name,
  rps,
  burst: Math.max(1, Math.ceil(rps)),
  tokens: Math.max(1, Math.ceil(rps)),
  lastRefill: Date.now(),
  fg: [],
  bg: [],
  blockedUntil: 0,
  consecutive429: 0,
  last429At: null,
  last429Message: null,
});

const buckets: Record<HeliusRateGroup, RateBucket> = {
  enhanced: makeBucket('enhanced', ENHANCED_RPS),
  rpc: makeBucket('rpc', RPC_RPS),
  admin: makeBucket('admin', ADMIN_RPS),
};

const counters = {
  logicalCalls: 0,
  totalCalls: 0,
  successes: 0,
  failures: 0,
  throttledCalls: 0,
  got429: 0,
  got5xx: 0,
  retries: 0,
  networkErrors: 0,
  timeouts: 0,
  droppedBackground: 0,
  dedupedCalls: 0,
  cacheHits: 0,
  applicationErrors: 0,
  lastSuccessAt: null as string | null,
  lastFailureAt: null as string | null,
  lastError: null as string | null,
};

const requestCache = new Map<string, { expiresAt: number; result: HeliusResult<unknown> }>();
const inFlightRequests = new Map<string, Promise<HeliusResult<unknown>>>();

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function refill(bucket: RateBucket, now = Date.now()) {
  const elapsed = Math.max(0, now - bucket.lastRefill);
  bucket.tokens = Math.min(bucket.burst, bucket.tokens + bucket.rps * elapsed / 1000);
  bucket.lastRefill = now;
}

function drain(bucket: RateBucket) {
  const now = Date.now();
  refill(bucket, now);
  if (now < bucket.blockedUntil) return;
  while (bucket.tokens >= 1 && (bucket.fg.length || bucket.bg.length)) {
    bucket.tokens -= 1;
    const waiter = bucket.fg.shift() || bucket.bg.shift();
    waiter?.resolve(true);
  }
}

const limiterTimer = setInterval(() => {
  drain(buckets.enhanced);
  drain(buckets.rpc);
  drain(buckets.admin);
}, 25);
limiterTimer.unref();

async function acquire(group: HeliusRateGroup, priority: HeliusPriority): Promise<boolean> {
  const bucket = buckets[group];
  const now = Date.now();
  refill(bucket, now);

  if (now < bucket.blockedUntil && priority === 'bg') {
    counters.droppedBackground++;
    return false;
  }

  if (now >= bucket.blockedUntil && bucket.tokens >= 1 && (priority === 'fg' || bucket.fg.length === 0)) {
    bucket.tokens -= 1;
    return true;
  }

  if (priority === 'bg' && bucket.bg.length >= MAX_BG_QUEUE) {
    counters.droppedBackground++;
    return false;
  }

  counters.throttledCalls++;
  return new Promise(resolve => {
    const queue = priority === 'fg' ? bucket.fg : bucket.bg;
    queue.push({ resolve, enqueuedAt: now });
  });
}

function dropQueuedBackground(bucket: RateBucket) {
  const dropped = bucket.bg.splice(0);
  counters.droppedBackground += dropped.length;
  for (const waiter of dropped) waiter.resolve(false);
}

export function redactHeliusText(value: unknown): string {
  let text: string;
  try { text = typeof value === 'string' ? value : JSON.stringify(value); }
  catch { text = String(value); }
  if (env.HELIUS_API_KEY) text = text.split(env.HELIUS_API_KEY).join('[REDACTED_API_KEY]');
  text = text.replace(/([?&](?:api-key|api_key)=)[^&\s"']+/gi, '$1[REDACTED_API_KEY]');
  return text.slice(0, 800);
}

export function isRetryableHeliusStatus(status: number): boolean {
  return status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

export function parseRetryAfterMs(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(5 * 60_000, Math.round(seconds * 1000));
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return null;
  return Math.max(0, Math.min(5 * 60_000, date - now));
}

export function heliusBackoffMs(
  attemptIndex: number,
  retryAfterMs: number | null,
  responseText = '',
  random = Math.random(),
): number {
  if (/max usage reached|credits? (?:exhausted|depleted)|out of credits/i.test(responseText)) return 5 * 60_000;
  if (retryAfterMs !== null) return Math.max(250, retryAfterMs);
  const exponential = Math.min(30_000, 1000 * 2 ** Math.max(0, attemptIndex));
  return Math.max(250, Math.round(exponential * (0.75 + Math.max(0, Math.min(1, random)) * 0.5)));
}

function openCircuit(group: HeliusRateGroup, delayMs: number, message: string) {
  const bucket = buckets[group];
  bucket.tokens = 0;
  bucket.consecutive429++;
  bucket.last429At = Date.now();
  bucket.last429Message = redactHeliusText(message);
  const circuitDelay = bucket.consecutive429 >= 3 ? Math.max(delayMs, 60_000) : delayMs;
  bucket.blockedUntil = Math.max(bucket.blockedUntil, Date.now() + circuitDelay);
  dropQueuedBackground(bucket);
}

function noteSuccess(group: HeliusRateGroup) {
  const bucket = buckets[group];
  bucket.consecutive429 = 0;
  if (bucket.blockedUntil <= Date.now()) bucket.blockedUntil = 0;
  counters.successes++;
  counters.lastSuccessAt = new Date().toISOString();
  counters.lastError = null;
}

function noteFailure(message: string) {
  counters.failures++;
  counters.lastFailureAt = new Date().toISOString();
  counters.lastError = redactHeliusText(message);
}

function parseBody(text: string): unknown {
  if (!text) return null;
  try { return JSON.parse(text); }
  catch { return text; }
}

function requestKey(url: string, init: RequestInit, group: HeliusRateGroup): string {
  const safeUrl = redactHeliusText(url);
  const method = String(init.method || 'GET').toUpperCase();
  const body = typeof init.body === 'string' ? init.body : init.body ? String(init.body) : '';
  return `${group}:${method}:${safeUrl}:${body}`;
}

function skippedResult<T>(reason: string): HeliusResult<T> {
  return { ok: false, status: 0, data: null, error: reason, skipped: true };
}

async function performRequest<T>(
  url: string,
  init: RequestInit,
  options: Required<Pick<HeliusRequestOptions, 'group' | 'priority' | 'timeoutMs' | 'maxAttempts'>>,
): Promise<HeliusResult<T>> {
  let last: HeliusResult<T> = { ok: false, status: 0, data: null, error: 'helius request did not run' };

  for (let attempt = 0; attempt < options.maxAttempts; attempt++) {
    const granted = await acquire(options.group, options.priority);
    if (!granted) return skippedResult<T>('helius_background_request_deferred');

    counters.totalCalls++;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      const text = await response.text();
      const parsed = parseBody(text) as T | null;
      last = {
        ok: response.ok,
        status: response.status,
        data: response.ok ? parsed : null,
        error: response.ok ? null : redactHeliusText(text || `HTTP ${response.status}`),
      };

      if (response.ok) {
        noteSuccess(options.group);
        return last;
      }

      if (response.status === 429) {
        counters.got429++;
        const retryAfter = parseRetryAfterMs(response.headers.get('retry-after'));
        const delay = heliusBackoffMs(attempt, retryAfter, text);
        openCircuit(options.group, delay, text || 'HTTP 429');
      } else if (response.status >= 500) {
        counters.got5xx++;
      }

      if (!isRetryableHeliusStatus(response.status) || attempt === options.maxAttempts - 1) {
        noteFailure(last.error || `HTTP ${response.status}`);
        return last;
      }

      counters.retries++;
      const retryAfter = parseRetryAfterMs(response.headers.get('retry-after'));
      await sleep(heliusBackoffMs(attempt, retryAfter, text));
    } catch (error) {
      const aborted = (error as Error).name === 'AbortError';
      if (aborted) counters.timeouts++;
      else counters.networkErrors++;
      last = {
        ok: false,
        status: 0,
        data: null,
        error: aborted ? `helius timeout after ${options.timeoutMs}ms` : redactHeliusText((error as Error).message),
      };
      if (attempt === options.maxAttempts - 1) {
        noteFailure(last.error || 'helius network failure');
        return last;
      }
      counters.retries++;
      await sleep(heliusBackoffMs(attempt, null));
    } finally {
      clearTimeout(timeout);
    }
  }

  noteFailure(last.error || 'helius request failed');
  return last;
}

export async function heliusRequest<T>(
  url: string,
  init: RequestInit = {},
  options: HeliusRequestOptions = {},
): Promise<HeliusResult<T>> {
  counters.logicalCalls++;
  const group = options.group || 'enhanced';
  const priority = options.priority || 'fg';
  const timeoutMs = Math.max(1000, options.timeoutMs || 8000);
  const maxAttempts = Math.max(1, Math.min(5, options.maxAttempts || (priority === 'bg' ? 2 : 5)));
  const key = options.dedupeKey || requestKey(url, init, group);
  const cached = requestCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    counters.cacheHits++;
    return cached.result as HeliusResult<T>;
  }
  if (cached) requestCache.delete(key);

  const existing = inFlightRequests.get(key);
  if (existing) {
    counters.dedupedCalls++;
    return existing as Promise<HeliusResult<T>>;
  }

  const promise = performRequest<T>(url, init, { group, priority, timeoutMs, maxAttempts });
  inFlightRequests.set(key, promise as Promise<HeliusResult<unknown>>);
  try {
    const result = await promise;
    if (result.ok && (options.cacheTtlMs || 0) > 0) {
      requestCache.set(key, { expiresAt: Date.now() + Number(options.cacheTtlMs), result: result as HeliusResult<unknown> });
    }
    return result;
  } finally {
    if (inFlightRequests.get(key) === promise) inFlightRequests.delete(key);
  }
}

export const heliusHealth = () => {
  const now = Date.now();
  const groupHealth = Object.fromEntries(Object.entries(buckets).map(([name, bucket]) => [name, {
    rps: bucket.rps,
    burst: bucket.burst,
    queuedFg: bucket.fg.length,
    queuedBg: bucket.bg.length,
    queued: bucket.fg.length + bucket.bg.length,
    blocked: now < bucket.blockedUntil,
    blockedUntil: bucket.blockedUntil > now ? new Date(bucket.blockedUntil).toISOString() : null,
    consecutive429: bucket.consecutive429,
    last429At: bucket.last429At ? new Date(bucket.last429At).toISOString() : null,
    last429Message: bucket.last429Message,
  }]));
  const queuedFg = Object.values(buckets).reduce((sum, bucket) => sum + bucket.fg.length, 0);
  const queuedBg = Object.values(buckets).reduce((sum, bucket) => sum + bucket.bg.length, 0);
  return {
    configured: !!env.HELIUS_API_KEY,
    // Compatibility fields retained for existing dashboards and reports.
    rps: ENHANCED_RPS,
    queuedFg,
    queuedBg,
    queued: queuedFg + queuedBg,
    totalCalls: counters.totalCalls,
    throttledCalls: counters.throttledCalls,
    got429: counters.got429,
    throttlePct: counters.logicalCalls ? Math.round(counters.throttledCalls / counters.logicalCalls * 100) : 0,
    http429Pct: counters.totalCalls ? Math.round(counters.got429 / counters.totalCalls * 100) : 0,
    successPct: counters.totalCalls ? Math.round(counters.successes / counters.totalCalls * 100) : 0,
    ...counters,
    groups: groupHealth,
    inFlightRequests: inFlightRequests.size,
    cacheEntries: requestCache.size,
  };
};

export async function heliusTxs(
  address: string,
  limit = 100,
  before?: string,
  priority: HeliusPriority = 'fg',
): Promise<any[]> {
  if (!env.HELIUS_API_KEY) return [];
  const url = `https://api.helius.xyz/v0/addresses/${encodeURIComponent(address)}/transactions?api-key=${encodeURIComponent(env.HELIUS_API_KEY)}&limit=${limit}`
    + (before ? `&before=${encodeURIComponent(before)}` : '');
  const result = await heliusRequest<any[]>(url, {}, {
    group: 'enhanced',
    priority,
    maxAttempts: priority === 'bg' ? 2 : 5,
    dedupeKey: `txs:${address}:${limit}:${before || ''}`,
    cacheTtlMs: before ? 60_000 : 15_000,
  });
  return result.ok && Array.isArray(result.data) ? result.data : [];
}

export async function heliusTxsToCreation(
  address: string,
  maxPages = 5,
  priority: HeliusPriority = 'bg',
): Promise<any[]> {
  let all: any[] = [];
  let before: string | undefined;
  for (let index = 0; index < maxPages; index++) {
    const page = await heliusTxs(address, 100, before, priority);
    if (!page.length) break;
    all = all.concat(page);
    if (page.length < 100) break;
    before = page[page.length - 1].signature;
  }
  return all;
}

export async function heliusRpc<T>(
  method: string,
  params: unknown[],
  priority: HeliusPriority = 'fg',
): Promise<T | null> {
  if (!env.HELIUS_API_KEY) return null;
  const result = await heliusRequest<{ result?: T; error?: { code?: number; message?: string } }>(
    `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(env.HELIUS_API_KEY)}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    },
    {
      group: 'rpc',
      priority,
      dedupeKey: `rpc:${method}:${JSON.stringify(params)}`,
      cacheTtlMs: method === 'getSignaturesForAddress' ? 30_000 : 0,
    },
  );
  if (!result.ok || !result.data) return null;
  if (result.data.error) {
    counters.applicationErrors++;
    counters.lastError = redactHeliusText(result.data.error);
    return null;
  }
  return result.data.result ?? null;
}

export async function earlyBuyers(mint: string, slotWindow = 3): Promise<string[]> {
  const txs = await heliusTxsToCreation(mint);
  if (!txs.length) return [];
  const minSlot = Math.min(...txs.map((tx: any) => tx.slot));
  const buyers = new Set<string>();
  for (const tx of txs) {
    if (tx.slot > minSlot + slotWindow) continue;
    for (const transfer of tx.tokenTransfers || [])
      if (transfer.mint === mint && transfer.toUserAccount) buyers.add(transfer.toUserAccount);
  }
  return [...buyers];
}

// Test-only reset used by the isolated limiter regression suite.
export function __resetHeliusForTest() {
  Object.assign(counters, {
    logicalCalls: 0, totalCalls: 0, successes: 0, failures: 0, throttledCalls: 0,
    got429: 0, got5xx: 0, retries: 0, networkErrors: 0, timeouts: 0,
    droppedBackground: 0, dedupedCalls: 0, cacheHits: 0, applicationErrors: 0,
    lastSuccessAt: null, lastFailureAt: null, lastError: null,
  });
  for (const bucket of Object.values(buckets)) {
    for (const waiter of [...bucket.fg, ...bucket.bg]) waiter.resolve(false);
    bucket.fg = [];
    bucket.bg = [];
    bucket.tokens = bucket.burst;
    bucket.lastRefill = Date.now();
    bucket.blockedUntil = 0;
    bucket.consecutive429 = 0;
    bucket.last429At = null;
    bucket.last429Message = null;
  }
  requestCache.clear();
  inFlightRequests.clear();
}
