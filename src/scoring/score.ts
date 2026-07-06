import { cfg } from '../config';
import { TokenRecord } from '../types';
import { activeWalletCount } from '../ingest/wallets';

// Weighted sum → 0–100. Each sub-score is 0–1 before weighting.
export function scoreToken(t: TokenRecord): number {
  const w = cfg().weights;
  const a = cfg().age;

  // freshness: exponential decay over the 4h window
  const ageMin = (Date.now() - t.firstSeen) / 60000;
  const freshness = Math.pow(0.5, ageMin / a.freshness_half_life_minutes);

  // liquidity health: ratio above floor + absolute depth (log-scaled, $12K→0, $150K+→1)
  const ratio = t.mcapUsd > 0 ? t.liquidityUsd / t.mcapUsd : 0;
  const ratioScore = Math.min(1, Math.max(0, (ratio - 0.08) / 0.25));
  const depthScore = Math.min(1, Math.max(0, Math.log10(Math.max(t.liquidityUsd, 1) / 12000) / Math.log10(150000 / 12000)));
  const liquidity = 0.5 * ratioScore + 0.5 * depthScore;

  // buy pressure: buys:sells ratio, saturating at 3:1
  const buyRatio = t.sells5m > 0 ? t.buys5m / t.sells5m : (t.buys5m > 0 ? 3 : 0);
  const buyPressure = Math.min(1, buyRatio / 3);

  // holder growth proxy: slope of rolling buy-count samples
  const s = t.uniqueBuyerSamples;
  let holderGrowth = 0;
  if (s.length >= 3) {
    const slope = (s[s.length - 1] - s[0]) / s.length;
    holderGrowth = Math.min(1, Math.max(0, slope / 10));   // +10 buys/sample = max
  }

  // smart money: distinct vetted wallets buying inside the hit window, capped at 2 for max
  const windowMs = cfg().wallets.hit_window_minutes * 60_000;
  const recentHits = new Set(t.smartHits.filter(h => Date.now() - h.at < windowMs).map(h => h.wallet)).size;
  const smartMoney = Math.min(1, recentHits / 2);

  // if no wallets are being tracked yet, redistribute that weight so max stays 100
  const scale = activeWalletCount() > 0 ? 1 : 100 / (100 - w.smart_money);

  t.subs = {
    freshness: round1(freshness * w.freshness * scale),
    liquidity: round1(liquidity * w.liquidity_health * scale),
    buyPressure: round1(buyPressure * w.buy_pressure * scale),
    holderGrowth: round1(holderGrowth * w.holder_growth * scale),
    smartMoney: round1(smartMoney * w.smart_money * (activeWalletCount() > 0 ? 1 : 0)),
  };
  const total = t.subs.freshness + t.subs.liquidity + t.subs.buyPressure + t.subs.holderGrowth + t.subs.smartMoney;
  t.score = round1(total);
  if (t.score > t.peakScore) t.peakScore = t.score;
  if (t.firstScorePrice === null && t.priceUsd > 0) t.firstScorePrice = t.priceUsd;
  return t.score;
}

const round1 = (x: number) => Math.round(x * 10) / 10;
