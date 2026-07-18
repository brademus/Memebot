import { cfg, env } from '../config';
import { TokenRecord } from '../types';

// The only buy alert in the public lifecycle. A token reaches this function only
// after it was selected into Convictions and then cleared the entry-timing gate.
export async function alertTrigger(token: TokenRecord) {
  if (!cfg().alerts.telegram_on_trigger) return;
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  if (token.score - token.lastAlertScore < cfg().alerts.realert_score_jump && token.lastAlertScore > 0) return;
  token.lastAlertScore = token.score;

  const moved = token.firstScorePrice && token.priceUsd
    ? ((token.priceUsd / token.firstScorePrice - 1) * 100).toFixed(0) : '0';
  const ageMin = Math.round((Date.now() - token.firstSeen) / 60000);
  const convictionHold = token.convictionAt
    ? Math.max(0, Math.round((Date.now() - token.convictionAt) / 1000)) : 0;
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
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
    });
  } catch (error) {
    console.error('[telegram]', (error as Error).message);
  }
}

const fmt = (value: number) => value >= 1e6
  ? (value / 1e6).toFixed(1) + 'M'
  : (value / 1e3).toFixed(0) + 'K';
