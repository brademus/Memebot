import { cfg } from '../config';
import { getToken, addToken } from '../store';
import { TokenRecord } from '../types';

// SOCIAL EDGE — cheap, fast, ban-proof. NOT X scraping (403/ToS/burns money).
// Two free signals that actually predict:
//
//   BOOSTS — Dexscreener's token-boosts feed lists tokens people are PAYING to
//   promote right now, with boost amount (money = harder-to-fake attention than
//   follower counts) and social links. A coin already in our pipeline that shows
//   up here is getting real promotional push; an unseen boosted coin with a big
//   amount is a discovery lead. Free, public, no auth, no rate pain.
//
//   TG VELOCITY — we already capture Telegram member COUNT once; the real tell is
//   member GROWTH RATE. 200 -> 800 in 20min is a pre-pump signal a static count
//   misses. Same free t.me scrape, sampled over time.
//
// Both are logged as measured signals (boostAmount, tgGrowthPerMin) so the
// calibrator can learn whether they predict — never a blind score bump.

const BOOSTS_LATEST = 'https://api.dexscreener.com/token-boosts/latest/v1';
const BOOSTS_TOP = 'https://api.dexscreener.com/token-boosts/top/v1';

const diag = { lastRun: null as string | null, lastError: null as string | null, boostsSeen: 0, surfaced: 0 };
export const socialDiag = () => ({ ...diag });

export function startSocialScanner(onFound: (ca: string) => void) {
  if (!cfg().social?.enabled) return;
  const tick = () => scanBoosts(onFound).catch(e => { diag.lastError = (e as Error).message; });
  setTimeout(tick, 45_000);
  setInterval(tick, Math.max(60, cfg().social.boost_poll_seconds) * 1000);
}

async function scanBoosts(onFound: (ca: string) => void) {
  diag.lastRun = new Date().toISOString();
  diag.lastError = null;
  const seen = new Map<string, { amount: number; total: number }>();
  for (const url of [BOOSTS_LATEST, BOOSTS_TOP]) {
    try {
      const res = await fetch(url, { headers: { accept: 'application/json' } });
      if (!res.ok) continue;
      const data: any = await res.json();
      for (const b of Array.isArray(data) ? data : []) {
        if (b.chainId !== 'solana' || !b.tokenAddress) continue;
        const prev = seen.get(b.tokenAddress) || { amount: 0, total: 0 };
        seen.set(b.tokenAddress, {
          amount: Math.max(prev.amount, Number(b.amount) || 0),
          total: Math.max(prev.total, Number(b.totalAmount) || 0),
        });
      }
    } catch { /* one endpoint failing is fine */ }
  }
  diag.boostsSeen = seen.size;

  const s = cfg().social;
  for (const [ca, boost] of seen) {
    const existing = getToken(ca);
    if (existing) {
      existing.boostAmount = boost.total;   // annotate — calibrator measures if it predicts
    } else if (boost.total >= s.boost_surface_min) {
      // an unseen coin with real paid promotion is a discovery lead — pull it in,
      // it rides the full gates like anything else (paid ≠ safe).
      const t = addToken({ ca, symbol: '?', name: '(boost-surfaced)', creator: null, source: 'momentum' });
      if (t) { t.boostAmount = boost.total; t.dex = 'raydium'; t.dexId = 'raydium'; diag.surfaced++; onFound(ca); }
    }
  }
}

// TG VELOCITY — called from the metadata layer's periodic re-fetch. Records a
// members sample and computes growth/min over the retained window.
export function recordTgSample(t: TokenRecord, members: number) {
  const now = Date.now();
  t.tgSamples = (t.tgSamples || []).filter(x => now - x.at < 30 * 60_000);
  t.tgSamples.push({ n: members, at: now });
  if (t.tgSamples.length >= 2) {
    const first = t.tgSamples[0], last = t.tgSamples[t.tgSamples.length - 1];
    const mins = (last.at - first.at) / 60_000;
    t.tgGrowthPerMin = mins > 0.5 ? Math.round((last.n - first.n) / mins) : 0;
  }
}
