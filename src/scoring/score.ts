import { cfg } from '../config';
import { TokenRecord } from '../types';
import { walletsTracked, weightedSmartHits } from '../wallets/tracker';
import { getStreamMode } from '../ingest/pumpfun';

// SCORING v3 — research-ranked signal weights.
// Evidence basis (2025-2026 academic + practitioner studies on pump.fun):
//   #1 LIQUIDITY VELOCITY: SOL bonded per trade — "the single most informative
//      predictor of graduation, dominating other variables across the entire range."
//      Reaching a SOL level in tens of trades >> hundreds of trades.
//   #2 ORGANIC PARTICIPATION: distinct-buyer spread — bot-churn-dominated tokens
//      graduate LESS despite high turnover; committed humans > mechanical volume.
//   #3 SOCIAL PRESENCE: X+TG+website = 17.4x graduation lift (TG alone 8.9x).
//   #4 BUY PRESSURE (volume-damped), #5 FRESHNESS, #6 SMART MONEY (secondary,
//      non-monotonic per research — smart wallets exit fast around graduation).
//   DEV SELF-BUY: hazard ratio 4.51 positive at moderate size (commitment),
//      but a large dev bag is structural dump risk — scored as a curve, not a line.

const GRADUATION_SOL = 85;
const CURVE_START_SOL = 30;

export function scoreToken(t: TokenRecord): number {
  const w = cfg().weights;
  const a = cfg().age;
  const onCurve = t.dex === 'pumpfun';

  const lite = getStreamMode() === 'lite';

  // ---- #1 liquidity velocity: SOL bonded per trade + acceleration ----
  const bonded = Math.max(0, t.curveSol - CURVE_START_SOL);
  const trades = lite ? (t.buys5m + t.sells5m) : (t.totalBuys + t.totalSells);
  let velocity: number;
  if (onCurve && lite) {
    // LITE: per-trade stream unavailable. Demand proxy = Dexscreener 5m volume
    // converted to SOL/min, progress = mcap fraction toward ~$69K graduation.
    const solPerMin = t.vol5m > 0 ? (t.vol5m / 5) / 82 : 0;   // rough SOL conversion; magnitude is what matters
    const vBase = clamp(solPerMin / 3);
    const progress = clamp(t.mcapUsd / 69000);
    velocity = 0.6 * vBase + 0.4 * progress;
  } else if (onCurve) {
    // sol-per-trade: 0.4+ SOL/trade = elite (50 SOL in ~50 trades), log-scaled
    const solPerTrade = trades > 0 ? bonded / trades : 0;
    const vBase = clamp(Math.log(1 + solPerTrade / 0.08) / Math.log(1 + 5));
    // inflow acceleration: velocity now vs a minute ago (2nd derivative of curve)
    const accel = clamp(curveAccel(t) / 2 + 0.5);   // -2..+2 SOL/min² -> 0..1
    // progress toward graduation as accumulated proof
    const progress = clamp(bonded / (GRADUATION_SOL - CURVE_START_SOL));
    velocity = 0.5 * vBase + 0.3 * accel + 0.2 * progress;
  } else {
    // post-graduation: AMM liquidity health (ratio + depth)
    const ratio = t.mcapUsd > 0 ? t.liquidityUsd / t.mcapUsd : 0;
    velocity = 0.5 * clamp((ratio - 0.08) / 0.25)
             + 0.5 * clamp(Math.log10(Math.max(t.liquidityUsd, 1) / 12000) / Math.log10(150000 / 12000));
  }

  // ---- #2 organic participation ----
  // LITE: no per-trade wallets -> log-scaled buy count is the best available proxy
  const uniq = lite ? 0 : t.uniqueBuyers.length;
  if (lite) {
    // fallthrough uses buys-only organic below
  }
  const uniqScore = clamp(Math.log(1 + uniq) / Math.log(1 + 80));
  const spread = t.totalBuys > 0 ? clamp(uniq / t.totalBuys / 0.7) : 0;  // 70%+ unique = fully organic
  const s = t.uniqueBuyerSamples;
  const slope = s.length >= 3 ? clamp((s[s.length - 1] - s[0]) / (s.length * 5)) : 0;
  const organic = lite
    ? clamp(Math.log(1 + t.buys5m) / Math.log(1 + 40))
    : 0.45 * uniqScore + 0.35 * spread + 0.2 * slope;

  // ---- #3 social presence: Telegram strongest, then X, then website ----
  const social = t.socials.fetched
    ? (t.socials.tg ? 0.5 : 0) + (t.socials.x ? 0.3 : 0) + (t.socials.web ? 0.2 : 0)
    : 0.25;   // unknown-yet: neutral-low, resolves within seconds of create

  // ---- #4 buy pressure: ratio damped by evidence volume ----
  const txns = t.buys5m + t.sells5m;
  const ratioScore = clamp(((t.buys5m + 1) / (t.sells5m + 1) - 1) / 2);
  const buyPressure = ratioScore * clamp(Math.log(1 + txns) / Math.log(1 + 25));

  // ---- #5 freshness ----
  const ageMin = (Date.now() - t.firstSeen) / 60000;
  const freshness = Math.pow(0.5, ageMin / a.freshness_half_life_minutes);

  // ---- #6 smart money (tier-weighted: one ELITE buy = full component) ----
  const winMs = cfg().wallets.hit_recency_hours * 3600_000;
  const { weight } = weightedSmartHits(t.smartHits, winMs);
  const smartMoney = Math.min(1, weight / 3);

  // ---- dev self-buy curve: moderate = commitment (+), large = dump risk (−) ----
  // 0.5-4% -> up to +5 bonus; >7% -> scaling penalty to −12 at 15%+
  const d = t.devBuyPct;
  const devAdj = d >= 0.5 && d <= 4 ? 5 * clamp((d - 0.5) / 1.5) * clamp((4 - d) / 1.5 + 0.34)
               : d > 7 ? -clamp((d - 7) / 8) * 12
               : 0;

  const walletsLive = walletsTracked();
  const scale = walletsLive ? 1 : 100 / (100 - w.smart_money);

  t.subs = {
    freshness: round1(freshness * w.freshness * scale),
    liquidity: round1(velocity * w.velocity * scale),          // 'liquidity' key kept for dashboard compat
    buyPressure: round1(buyPressure * w.buy_pressure * scale),
    holderGrowth: round1((0.6 * organic + 0.4 * social) * (w.organic + w.social) * scale), // combined for compat
    smartMoney: round1(smartMoney * w.smart_money * (walletsLive ? 1 : 0)),
  };
  const total = t.subs.freshness + t.subs.liquidity + t.subs.buyPressure + t.subs.holderGrowth + t.subs.smartMoney + devAdj;
  t.score = round1(Math.max(0, Math.min(100, total)));
  if (t.score > t.peakScore) t.peakScore = t.score;
  if (t.firstScorePrice === null && t.priceUsd > 0) t.firstScorePrice = t.priceUsd;
  return t.score;
}

// SOL/min² over recent samples: is inflow speeding up or stalling?
function curveAccel(t: TokenRecord): number {
  const cs = t.curveSamples;
  if (cs.length < 4) return 0;
  const now = Date.now();
  const recent = cs.filter(x => now - x.at < 60_000);
  const prior = cs.filter(x => now - x.at >= 60_000 && now - x.at < 150_000);
  const v = (arr: typeof cs) => {
    if (arr.length < 2) return 0;
    const dMin = (arr[arr.length - 1].at - arr[0].at) / 60000;
    return dMin > 0 ? (arr[arr.length - 1].sol - arr[0].sol) / dMin : 0;
  };
  return v(recent) - v(prior);
}

const clamp = (x: number) => Math.min(1, Math.max(0, x));
const round1 = (x: number) => Math.round(x * 10) / 10;
