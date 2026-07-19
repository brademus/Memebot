import { cfg, env } from '../config';
import { convictionQueueStatus } from '../scoring/conviction-queue';
import { TokenRecord } from '../types';

export interface AlertDeliveryResult {
  attempted: boolean;
  sent: boolean;
  statusCode: number | null;
  skippedReason: string | null;
  error: string | null;
  completedAt: number;
}

const skipped = (reason: string): AlertDeliveryResult => ({
  attempted: false,
  sent: false,
  statusCode: null,
  skippedReason: reason,
  error: null,
  completedAt: Date.now(),
});

// The only buy alert in the public lifecycle. A token reaches this function only
// after it was selected into Convictions and then cleared the entry-timing gate.
export async function alertTrigger(token: TokenRecord): Promise<AlertDeliveryResult> {
  if (!cfg().alerts.telegram_on_trigger) return skipped('telegram_alerts_disabled');
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return skipped('telegram_credentials_missing');
  if (token.score - token.lastAlertScore < cfg().alerts.realert_score_jump && token.lastAlertScore > 0) {
    return skipped('realert_score_jump_not_met');
  }
  token.lastAlertScore = token.score;

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

  try {
    const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
    });
    return {
      attempted: true,
      sent: response.ok,
      statusCode: response.status,
      skippedReason: null,
      error: response.ok ? null : `telegram_http_${response.status}`,
      completedAt: Date.now(),
    };
  } catch (error) {
    const message = (error as Error).message;
    console.error('[telegram]', message);
    return {
      attempted: true,
      sent: false,
      statusCode: null,
      skippedReason: null,
      error: message,
      completedAt: Date.now(),
    };
  }
}

const fmt = (value: number) => value >= 1e6
  ? (value / 1e6).toFixed(1) + 'M'
  : (value / 1e3).toFixed(0) + 'K';
