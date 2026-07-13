import { cfg } from '../config';
import { activeTokens, getToken, addToken } from '../store';
import { refreshTelegramMembers } from './metadata';

const BOOSTS_LATEST = 'https://api.dexscreener.com/token-boosts/latest/v1';
const BOOSTS_TOP = 'https://api.dexscreener.com/token-boosts/top/v1';
const diag = { lastRun: null as string | null, lastError: null as string | null, boostsSeen: 0, surfaced: 0, telegramSampled: 0 };
export const socialDiag = () => ({ ...diag });

export function startSocialScanner(onFound: (ca: string) => void) {
  if (!cfg().social?.enabled) return;
  const tick = () => scan(onFound).catch(error => { diag.lastError = (error as Error).message; });
  setTimeout(tick, 45_000);
  setInterval(tick, Math.max(60, cfg().social.boost_poll_seconds) * 1000);
}

async function scan(onFound: (ca: string) => void) {
  diag.lastRun = new Date().toISOString();
  diag.lastError = null;
  const seen = new Map<string, { amount: number; total: number }>();
  for (const url of [BOOSTS_LATEST, BOOSTS_TOP]) {
    try {
      const res = await fetch(url, { headers: { accept: 'application/json' } });
      if (!res.ok) continue;
      const data: any = await res.json();
      for (const boost of Array.isArray(data) ? data : []) {
        if (boost.chainId !== 'solana' || !boost.tokenAddress) continue;
        const prior = seen.get(boost.tokenAddress) || { amount: 0, total: 0 };
        seen.set(boost.tokenAddress, {
          amount: Math.max(prior.amount, Number(boost.amount) || 0),
          total: Math.max(prior.total, Number(boost.totalAmount) || 0),
        });
      }
    } catch {}
  }
  diag.boostsSeen = seen.size;

  const settings = cfg().social;
  for (const [ca, boost] of seen) {
    const existing = getToken(ca);
    if (existing) existing.boostAmount = boost.total;
    else if (boost.total >= settings.boost_surface_min) {
      const token = addToken({ ca, symbol: ca.slice(0, 4) + '…', name: '(boost-surfaced)', creator: null, source: 'momentum' });
      if (token) {
        token.boostAmount = boost.total;
        token.dex = 'raydium';
        token.dexId = 'raydium';
        diag.surfaced++;
        onFound(ca);
      }
    }
  }

  // A single metadata scrape cannot produce velocity. Resample live Telegram-backed
  // candidates in bounded batches so member growth becomes a real measured feature.
  const telegram = activeTokens()
    .filter(token => token.socials.tg)
    .sort((a, b) => b.score - a.score)
    .slice(0, 30);
  diag.telegramSampled = telegram.length;
  for (let index = 0; index < telegram.length; index += 5)
    await Promise.all(telegram.slice(index, index + 5).map(token => refreshTelegramMembers(token)));
}
