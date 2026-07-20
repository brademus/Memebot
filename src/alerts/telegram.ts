import { cfg, env } from '../config';
import { MODEL_VERSION } from '../model/version';
import { recordLatestPaperEvent } from '../paper/call-events';
import { convictionQueueStatus } from '../scoring/conviction-queue';
import { TokenRecord } from '../types';

export interface AlertDeliveryResult {
  attempted: boolean;
  sent: boolean;
  statusCode: number | null;
  skippedReason: string | null;
  error: string | null;
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
  lastKind: null as string | null,
  lastAttemptAt: null as string | null,
  lastSuccessAt: null as string | null,
  lastFailureAt: null as string | null,
  lastStatusCode: null as number | null,
  lastError: null as string | null,
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

export function telegramRetryDelayMs(attemptIndex: number, retryAfter: string | null, random = Math.random()): number {
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(60_000, Math.max(500, Math.round(seconds * 1000)));
  const base = Math.min(15_000, 1_000 * 2 ** Math.max(0, attemptIndex));
  return Math.max(500, Math.round(base * (0.8 + Math.max(0, Math.min(1, random)) * 0.4)));
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
    }
  }
  return result;
}

async function sendTelegramText(text: string, kind: 'buy_alert' | 'canary'): Promise<AlertDeliveryResult> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return finish(skipped('telegram_credentials_missing'), kind);
  const startedAt = Date.now();
  let lastStatus: number | null = null;
  let lastError: string | null = null;

  for (let attempt = 0; attempt < 3; attempt++) {
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
        return finish({
          attempted: true,
          sent: true,
          statusCode: response.status,
          skippedReason: null,
          error: null,
          completedAt: Date.now(),
          attemptCount: attempt + 1,
          latencyMs: Date.now() - startedAt,
        }, kind);
      }
      lastError = `telegram_http_${response.status}`;
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === 2) break;
      health.retries++;
      await sleep(telegramRetryDelayMs(attempt, response.headers.get('retry-after')));
    } catch (error) {
      lastError = (error as Error).name === 'AbortError' ? 'telegram_timeout' : (error as Error).message;
      if (attempt === 2) break;
      health.retries++;
      await sleep(telegramRetryDelayMs(attempt, null));
    } finally {
      clearTimeout(timeout);
    }
  }

  console.error('[telegram]', lastError || 'delivery failed');
  return finish({
    attempted: true,
    sent: false,
    statusCode: lastStatus,
    skippedReason: null,
    error: lastError || 'telegram_delivery_failed',
    completedAt: Date.now(),
    attemptCount: 3,
    latencyMs: Date.now() - startedAt,
  }, kind);
}

async function persistDelivery(token: TokenRecord, result: AlertDeliveryResult): Promise<AlertDeliveryResult> {
  await recordLatestPaperEvent(
    token.ca,
    'trigger',
    MODEL_VERSION,
    token,
    result.sent ? 'alert_delivery_succeeded' : result.attempted ? 'alert_delivery_failed' : 'alert_delivery_skipped',
    'alert_delivery',
    token.priceUsd || null,
    result.sent ? 'telegram accepted the buy alert' : result.skippedReason || result.error,
    result,
    result.completedAt,
  ).catch(() => {});
  return result;
}

// The only buy alert in the public lifecycle. A token reaches this function only
// after it was selected into Convictions and then cleared the entry-timing gate.
export async function alertTrigger(token: TokenRecord): Promise<AlertDeliveryResult> {
  if (!cfg().alerts.telegram_on_trigger) return persistDelivery(token, finish(skipped('telegram_alerts_disabled'), 'buy_alert'));
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID)
    return persistDelivery(token, finish(skipped('telegram_credentials_missing'), 'buy_alert'));
  if (token.score - token.lastAlertScore < cfg().alerts.realert_score_jump && token.lastAlertScore > 0) {
    return persistDelivery(token, finish(skipped('realert_score_jump_not_met'), 'buy_alert'));
  }

  const moved = token.firstScorePrice && token.priceUsd
    ? ((token.priceUsd / token.firstScorePrice - 1) * 100).toFixed(0) : '0';
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
  ].filter(Boolean).join('\n');

  const result = await sendTelegramText(text, 'buy_alert');
  if (result.sent) token.lastAlertScore = token.score;
  return persistDelivery(token, result);
}

export async function sendTelegramCanary(): Promise<AlertDeliveryResult> {
  return sendTelegramText([
    '🟢 MEMEBOT PRIVATE HEALTH CANARY',
    `Service is online. Uptime: ${Math.round(process.uptime() / 60)} minutes.`,
    `Model: ${MODEL_VERSION} (shadow-only; no transaction broadcasting).`,
    `Time: ${new Date().toISOString()}`,
  ].join('\n'), 'canary');
}

let canaryStarted = false;
export function startTelegramHealthCanary() {
  if (canaryStarted || !health.configured || process.env.TELEGRAM_CANARY_ENABLED === 'false') return;
  canaryStarted = true;
  const first = setTimeout(() => { void sendTelegramCanary(); }, 10 * 60_000);
  first.unref();
  const daily = setInterval(() => { void sendTelegramCanary(); }, 24 * 60 * 60_000);
  daily.unref();
}

startTelegramHealthCanary();

const fmt = (value: number) => value >= 1e6
  ? (value / 1e6).toFixed(1) + 'M'
  : (value / 1e3).toFixed(0) + 'K';
