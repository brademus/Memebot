import { cfg } from '../config';
import { RawScoreFeatures, TokenRecord } from '../types';
import { walletsTracked, weightedSmartHits } from '../wallets/tracker';
import { getStreamMode, getSolPrice } from '../ingest/pumpfun';
import { getDirection } from '../config';
import { CURVE_START_SOL, GRADUATION_SOL, GRADUATION_MCAP_USD, CURVE_SPAN_SOL } from '../constants';

// SCORING v3 — research-ranked signal weights.
// Raw normalized features are persisted alongside the weighted dashboard subscores.
// Calibration trains only on the raw values so yesterday's weights cannot influence
// tomorrow's estimate of which signal matters.
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
    const solPerMin = t.vol5m > 0 ? (t.vol5m / 5) / getSolPrice() : 0;
    const vBase = clamp(solPerMin / 3);
    const progress = clamp(t.mcapUsd / GRADUATION_MCAP_USD);
    velocity = 0.6 * vBase + 0.4 * progress;
  } else if (onCurve) {
    const solPerTrade = trades > 0 ? bonded / trades : 0;
    const vBase = clamp(Math.log(1 + solPerTrade / 0.08) / Math.log(1 + 5));
    const accel = clamp(curveAccel(t) / 2 + 0.5);
    const progress = clamp(bonded / CURVE_SPAN_SOL);
    velocity = 0.5 * vBase + 0.3 * accel + 0.2 * progress;
  } else {
    const ratio = t.mcapUsd > 0 ? t.liquidityUsd / t.mcapUsd : 0;
    velocity = 0.5 * clamp((ratio - 0.08) / 0.25)
             + 0.5 * clamp(Math.log10(Math.max(t.liquidityUsd, 1) / 12000) / Math.log10(150000 / 12000));
  }

  // ---- #2 organic participation ----
  const noStream = lite || t.dex !== 'pumpfun' || t.source === 'momentum';
  const uniq = noStream ? 0 : t.uniqueBuyers.length;
  const uniqScore = clamp(Math.log(1 + uniq) / Math.log(1 + 80));
  const spread = t.totalBuys > 0 ? clamp(uniq / t.totalBuys / 0.7) : 0;
  const s = t.uniqueBuyerSamples;
  const slope = s.length >= 3 ? clamp((s[s.length - 1] - s[0]) / (s.length * 5)) : 0;
  const organic = noStream
    ? clamp(Math.log(1 + t.buys5m) / Math.log(1 + 40))
    : 0.45 * uniqScore + 0.35 * spread + 0.2 * slope;

  // ---- #3 social presence ----
  const ls = cfg().launch_signals;
  const tgW = !t.socials.tg ? 0
    : t.socials.tgMembers === null ? 0.4
    : t.socials.tgMembers < (ls?.tg_shell_max_members ?? 25) ? 0.15
    : t.socials.tgMembers < (ls?.tg_real_min_members ?? 200) ? 0.35
    : 0.5;
  const social = t.socials.fetched
    ? tgW + (t.socials.x ? 0.3 : 0) + (t.socials.web ? 0.2 : 0)
    : 0.25;

  // ---- #4 buy pressure ----
  const txns = t.buys5m + t.sells5m;
  const ratioScore = clamp(((t.buys5m + 1) / (t.sells5m + 1) - 1) / 2);
  const buyPressure = ratioScore * clamp(Math.log(1 + txns) / Math.log(1 + 25));

  // ---- #5 freshness ----
  const ageMin = (Date.now() - t.firstSeen) / 60000;
  const freshness = Math.pow(0.5, ageMin / a.freshness_half_life_minutes);

  // ---- #6 smart money ----
  const winMs = cfg().wallets.hit_recency_hours * 3600_000;
  const { weight } = weightedSmartHits(t.smartHits, winMs);
  const smartMoney = Math.min(1, weight / 3);

  const raw: RawScoreFeatures = {
    freshness: clamp(freshness),
    velocity: clamp(velocity),
    buy_pressure: clamp(buyPressure),
    organic: clamp(organic),
    social: clamp(social),
    smart_money: clamp(smartMoney),
  };

  // ---- dev self-buy curve ----
  const d = t.devBuyPct;
  const devAdj = d >= 0.5 && d <= 4 ? 5 * clamp((d - 0.5) / 1.5) * clamp((4 - d) / 1.5 + 0.34)
               : d > 7 ? -clamp((d - 7) / 8) * 12
               : 0;

  const walletsLive = walletsTracked();
  const scale = walletsLive ? 1 : 100 / (100 - w.smart_money);
  const dir = (key: string, v: number) => getDirection(key) < 0 ? (1 - v) : v;
  const freshnessD = dir('freshness', raw.freshness);
  const velocityD = dir('velocity', raw.velocity);
  const buyPressureD = dir('buy_pressure', raw.buy_pressure);
  const organicD = dir('organic', raw.organic);
  const smartMoneyD = dir('smart_money', raw.smart_money);

  t.subs = {
    freshness: round1(freshnessD * w.freshness * scale),
    liquidity: round1(velocityD * w.velocity * scale),
    buyPressure: round1(buyPressureD * w.buy_pressure * scale),
    holderGrowth: round1((0.6 * organicD + 0.4 * raw.social) * (w.organic + w.social) * scale),
    smartMoney: round1(smartMoneyD * w.smart_money * (walletsLive ? 1 : 0)),
    raw,
  };

  // ---- launch-signal priors ----
  let gradBonus = 0;
  if (t.dex === 'pumpfun' && ls && t.curveSol > 0) {
    const grad = GRADUATION_SOL;
    if (t.curveSol >= grad * 0.8 && t.curveSol <= grad * 1.02) {
      const ref = t.curveSamples.find(cs => Date.now() - cs.at >= 3 * 60_000);
      const inflow = !ref || t.curveSol >= ref.sol;
      if (inflow) gradBonus = ls.graduation_bonus_max * Math.min(1, (t.curveSol - grad * 0.8) / (grad * 0.2));
    }
  }
  const hourUtc = new Date(t.firstSeen).getUTCHours();
  const deadPenalty = ls?.dead_hours_utc?.includes(hourUtc) ? (ls.dead_hours_penalty ?? 0) : 0;

  const aiDelta = t.aiConviction?.delta || 0;
  const repDelta = t.deployerRep?.delta || 0;
  const total = t.subs.freshness + t.subs.liquidity + t.subs.buyPressure + t.subs.holderGrowth + t.subs.smartMoney + devAdj + gradBonus + aiDelta + repDelta - deadPenalty;
  t.score = round1(Math.max(0, Math.min(100, total)));
  if (t.score > t.peakScore) t.peakScore = t.score;
  if (t.firstScorePrice === null && t.priceUsd > 0) t.firstScorePrice = t.priceUsd;
  return t.score;
}

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
