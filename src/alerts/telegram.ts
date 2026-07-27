import { cfg, env } from '../config';
import { MODEL_VERSION } from '../model/version';
import { recordLatestPaperEvent } from '../paper/call-events';
import { convictionQueueStatus } from '../scoring/conviction-queue';
import { TokenRecord } from '../types';
import { telegramRetryDelayMs } from './telegram-retry';

export interface TelegramError {
  kind: 'chat_not_found' | 'bot_blocked' | 'unauthorized_token' | 'malformed_chat_id' | 'message_too_long' | 'rate_limited' | 'malformed_request' | 'telegram_server_error' | 'network_error';
  statusCode: number | null;
  description: string | null;
}

export interface AlertDeliveryResult {
  attempted: boolean;
  sent: boolean;
  statusCode: number | null;
  skippedReason: string | null;
  error: TelegramError | null;
  completedAt: number;
  attemptCount?: number;
  latencyMs?: number;
}

const health = {
  configured: !!(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID),
  deliveries: 0,
  sent: 0,
  failed: 0,
  skipped: 0,
  networkAttempts: 0,
  retries: 0,
  canaries: 0,
  canariesSent: 0,
  canaryTested: false,
  canaryResult: null as TelegramError | null,
  lastKind: null as string | null,
  lastAttemptAt: null as string | null,
  lastSuccessAt: null as string | null,
  lastFailureAt: null as string | null,
  lastStatusCode: null as number | null,
  lastError: null as TelegramError | null,
  lastLatencyMs: null as number | null,
  lastCanaryAt: null as string | null,
  lastCanarySuccessAt: null as string | null,
};

export const telegramDiag = () => ({ ...health });

const skipped = (reason: string): AlertDeliveryResult => ({
  attempted: false,
  sent: false,
  statusCode: null,
  skippedReason: reason,
  error: null,
  completedAt: Date.now(),
  attemptCount: 0,
  latencyMs: 0,
});

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function sanitizeDescription(raw: string | null): string | null {
  if (!raw) return null;
  // Strip URLs, query parameters, and tokens to prevent secret leakage
  let sanitized = raw
    .replace(/https?:\/\/[^\s]*/gi, '[URL]')
    .replace(/([?&])(api[-_]?key|token|secret|key)=[^&\s]*/gi, '$1[REDACTED]')
    .replace(/\b(sk|pk)_[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]');
  return sanitized.slice(0, 200);
}

function parseTelegramError(statusCode: number, responseBody: string): TelegramError {
  // Try to parse Telegram JSON error response
  let parsed: any = null;
  try {
    parsed = JSON.parse(responseBody);
  } catch {
    // Not JSON, treat as generic API error
  }

  const description = sanitizeDescription(parsed?.description || responseBody) || null;
  const errorCode = parsed?.error_code || null;

  // Map Telegram error codes and descriptions to diagnostic kinds
  if (statusCode === 400) {
    // Only classify description-specific 400 cases; generic 400 stays generic
    if (description?.includes('chat not found')) {
      return { kind: 'chat_not_found', statusCode, description };
    }
    if (description?.includes('bot was blocked by the user') || description?.includes('user is deactivated')) {
      return { kind: 'bot_blocked', statusCode, description };
    }
    if (description?.includes('CHAT_INVALID') || (description?.includes('Forbidden') && description?.includes('chat'))) {
      return { kind: 'chat_not_found', statusCode, description };
    }
    if (description?.includes('message text is empty') || description?.includes('text too long')) {
      return { kind: 'message_too_long', statusCode, description };
    }
    if (description?.includes('malformed') || description?.includes('invalid')) {
      return { kind: 'malformed_chat_id', statusCode, description };
    }
    // Generic 400: stay generic, don't guess chat_not_found
    return { kind: 'malformed_request', statusCode, description };
  }

  if (statusCode === 401 || statusCode === 403) {
    return { kind: 'unauthorized_token', statusCode, description };
  }

  if (statusCode === 429) {
    return { kind: 'rate_limited', statusCode, description };
  }

  if (statusCode >= 500) {
    return { kind: 'telegram_server_error', statusCode, description };
  }

  return { kind: 'network_error', statusCode, description };
}

export function classifyTelegramError(statusCode: number, responseBody: string): TelegramError {
  return parseTelegramError(statusCode, responseBody);
}

function finish(result: AlertDeliveryResult, kind: string): AlertDeliveryResult {
  health.deliveries++;
  health.lastKind = kind;
  health.lastAttemptAt = new Date(result.completedAt).toISOString();
  health.lastStatusCode = result.statusCode;
  health.lastLatencyMs = result.latencyMs ?? null;
  health.lastError = result.error;
  if (result.sent) {
    health.sent++;
    health.lastSuccessAt = health.lastAttemptAt;
    health.lastError = null;
  } else if (result.attempted) {
    health.failed++;
    health.lastFailureAt = health.lastAttemptAt;
  } else {
    health.skipped++;
  }
  if (kind === 'canary') {
    health.canaries++;
    health.lastCanaryAt = health.lastAttemptAt;
    if (result.sent) {
      health.canariesSent++;
      health.lastCanarySuccessAt = health.lastAttemptAt;
    } else if (result.error) {
      health.canaryTested = true;
      health.canaryResult = result.error;
    }
  }
  return result;
}

async function sendTelegramText(text: string, kind: 'buy_alert' | 'canary'): Promise<AlertDeliveryResult> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    return finish(skipped('telegram_credentials_missing'), kind);
  }

  const startedAt = Date.now();
  let lastStatus: number | null = null;
  let lastError: TelegramError | null = null;
  let attemptsMade = 0;

  for (let attempt = 0; attempt < 3; attempt++) {
    attemptsMade = attempt + 1;
    health.networkAttempts++;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    try {
      const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
        signal: controller.signal,
      });
      lastStatus = response.status;

      if (response.ok) {
        return finish(
          {
            attempted: true,
            sent: true,
            statusCode: response.status,
            skippedReason: null,
            error: null,
            completedAt: Date.now(),
            attemptCount: attemptsMade,
            latencyMs: Date.now() - startedAt,
          },
          kind,
        );
      }

      // Read response body to extract Telegram error details
      const responseBody = await response.text().catch(() => '');
      lastError = parseTelegramError(response.status, responseBody);

      // Do not retry non-retryable Telegram errors (config mistakes, blocked bot, etc.)
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable) {
        break;
      }

      if (attempt === 2) break; // Last attempt reached
      health.retries++;
      await sleep(telegramRetryDelayMs(attempt, response.headers.get('retry-after')));
    } catch (error) {
      const errorName = (error as Error).name;
      if (errorName === 'AbortError') {
        lastError = { kind: 'network_error', statusCode: null, description: 'request timeout' };
      } else {
        lastError = { kind: 'network_error', statusCode: null, description: (error as Error).message.slice(0, 200) };
      }

      if (attempt === 2) break;
      health.retries++;
      await sleep(telegramRetryDelayMs(attempt, null));
    } finally {
      clearTimeout(timeout);
    }
  }

  const errorDesc = lastError?.kind || 'delivery failed';
  console.error('[telegram]', errorDesc);
  return finish(
    {
      attempted: true,
      sent: false,
      statusCode: lastStatus,
      skippedReason: null,
      error: lastError,
      completedAt: Date.now(),
      attemptCount: attemptsMade,
      latencyMs: Date.now() - startedAt,
    },
    kind,
  );
}

async function persistDelivery(token: TokenRecord, result: AlertDeliveryResult): Promise<AlertDeliveryResult> {
  const eventName = result.sent ? 'alert_delivery_succeeded' : result.attempted ? 'alert_delivery_failed' : 'alert_delivery_skipped';
  const details = result.sent
    ? 'telegram accepted the buy alert'
    : result.skippedReason ||
      (result.error ? `telegram ${result.error.kind}` : 'delivery failed');

  await recordLatestPaperEvent(
    token.ca,
    'trigger',
    MODEL_VERSION,
    token,
    eventName,
    'alert_delivery',
    token.priceUsd || null,
    details,
    {
      attempted: result.attempted,
      sent: result.sent,
      statusCode: result.statusCode,
      error: result.error ? { kind: result.error.kind, statusCode: result.error.statusCode } : null,
      attemptCount: result.attemptCount,
      latencyMs: result.latencyMs,
    },
    result.completedAt,
  ).catch(() => {});
  return result;
}

// The only buy alert in the public lifecycle. A token reaches this function only
// after it was selected into Convictions and then cleared the entry-timing gate.
export async function alertTrigger(token: TokenRecord): Promise<AlertDeliveryResult> {
  if (!cfg().alerts.telegram_on_trigger) {
    return persistDelivery(token, finish(skipped('telegram_alerts_disabled'), 'buy_alert'));
  }
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    return persistDelivery(token, finish(skipped('telegram_credentials_missing'), 'buy_alert'));
  }
  if (token.score - token.lastAlertScore < cfg().alerts.realert_score_jump && token.lastAlertScore > 0) {
    return persistDelivery(token, finish(skipped('realert_score_jump_not_met'), 'buy_alert'));
  }

  const moved = token.firstScorePrice && token.priceUsd
    ? ((token.priceUsd / token.firstScorePrice - 1) * 100).toFixed(0)
    : '0';
  const ageMin = Math.round((Date.now() - token.firstSeen) / 60000);
  // Use the live queue timestamp rather than persisted conviction_at. After a worker
  // restart the token must re-enter and re-serve its hold; the alert must not claim
  // that an older, interrupted observation window counted toward this entry.
  const conviction = convictionQueueStatus(token.ca);
  const convictionHold = Math.round(conviction.heldSeconds);
  const text = [
    `📣 BUY ALERT — $${token.symbol}  [${token.score}]`,
    `Conviction held ${convictionHold}s; entry timing now cleared.`,
    `age ${ageMin}m | liq $${fmt(token.liquidityUsd)} | mcap $${fmt(token.mcapUsd)} | ratio ${(token.liquidityUsd / Math.max(token.mcapUsd, 1) * 100).toFixed(0)}%`,
    `buys:sells 5m ${token.buys5m}:${token.sells5m} | 5m move ${token.priceChange5m.toFixed(1)}% | moved ${moved}% since first score`,
    `chart: https://dexscreener.com/solana/${token.pairAddress || token.ca}`,
    `swap: https://jup.ag/swap/SOL-${token.ca}`,
    `CA: ${token.ca}`,
    token.aiNote ? `\n🧠 ${token.aiNote}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const result = await sendTelegramText(text, 'buy_alert');
  if (result.sent) token.lastAlertScore = token.score;
  return persistDelivery(token, result);
}

export async function sendTelegramCanary(): Promise<AlertDeliveryResult> {
  return sendTelegramText(
    [
      '🟢 MEMEBOT PRIVATE HEALTH CANARY',
      `Service is online. Uptime: ${Math.round(process.uptime() / 60)} minutes.`,
      `Model: ${MODEL_VERSION} (shadow-only; no transaction broadcasting).`,
      `Time: ${new Date().toISOString()}`,
    ].join('\n'),
    'canary',
  );
}

let canaryStarted = false;
let canaryBootDeferred = false;

export function startTelegramHealthCanary() {
  if (canaryStarted || !health.configured || process.env.TELEGRAM_CANARY_ENABLED === 'false') return;
  canaryStarted = true;

  // Boot canary: test the current Telegram configuration immediately
  if (!canaryBootDeferred) {
    canaryBootDeferred = true;
    const bootCanaryTimeout = setTimeout(() => {
      void sendTelegramCanary().catch(() => {});
    }, 2_000); // Defer slightly to allow boot to stabilize
    bootCanaryTimeout.unref();
  }

  // Periodic canaries every 10 minutes, then daily
  const first = setTimeout(() => {
    void sendTelegramCanary();
  }, 10 * 60_000);
  first.unref();
  const daily = setInterval(() => {
    void sendTelegramCanary();
  }, 24 * 60 * 60_000);
  daily.unref();
}

startTelegramHealthCanary();

const fmt = (value: number) =>
  value >= 1e6 ? (value / 1e6).toFixed(1) + 'M' : (value / 1e3).toFixed(0) + 'K';