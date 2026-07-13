import { cfg } from '../config';
import { RawScoreFeatures, TokenRecord } from '../types';
import { walletsTracked, weightedSmartHits } from '../wallets/tracker';
import { getStreamMode, getSolPrice } from '../ingest/pumpfun';
import { getDirection } from '../config';
import { CURVE_START_SOL, GRADUATION_SOL, GRADUATION_MCAP_USD, CURVE_SPAN_SOL } from '../constants';

// SCORING v4. Raw normalized features are persisted and the live total is computed
// from the exact same six independent components used by the calibrator.
export function scoreToken(t: TokenRecord): number {
  const w = cfg().weights;
  const a = cfg().age;
  const onCurve = t.dex === 'pumpfun';
  const lite = getStreamMode() === 'lite';

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

  const noStream = lite || t.dex !== 'pumpfun' || t.source === 'momentum';
  const uniq = noStream ? 0 : t.uniqueBuyers.length;
  const uniqScore = clamp(Math.log(1 + uniq) / Math.log(1 + 80));
  const spread = t.totalBuys > 0 ? clamp(uniq / t.totalBuys / 0.7) : 0;
  const samples = t.uniqueBuyerSamples;
  const slope = samples.length >= 3 ? clamp((samples[samples.length - 1] - samples[0]) / (samples.length * 5)) : 0;
  const organic = noStream
    ? clamp(Math.log(1 + t.buys5m) / Math.log(1 + 40))
    : 0.45 * uniqScore + 0.35 * spread + 0.2 * slope;

  const ls = cfg().launch_signals;
  const tgBase = !t.socials.tg ? 0
    : t.socials.tgMembers === null ? 0.4
    : t.socials.tgMembers < ls.tg_shell_max_members ? 0.15
    : t.socials.tgMembers < ls.tg_real_min_members ? 0.35
    : 0.5;
  const staticSocial = t.socials.fetched
    ? tgBase + (t.socials.x ? 0.3 : 0) + (t.socials.web ? 0.2 : 0)
    : 0.25;
  const boostSignal = clamp(Math.log1p(Math.max(0, t.boostAmount || 0)) / Math.log(101));
  const tgVelocitySignal = clamp(Math.max(0, t.tgGrowthPerMin || 0) / 20);
  const social = clamp(0.75 * staticSocial + 0.15 * boostSignal + 0.10 * tgVelocitySignal);

  const txns = t.buys5m + t.sells5m;
  const ratioScore = clamp(((t.buys5m + 1) / (t.sells5m + 1) - 1) / 2);
  const buyPressure = ratioScore * clamp(Math.log(1 + txns) / Math.log(1 + 25));
  const ageMin = (Date.now() - t.firstSeen) / 60000;
  const freshness = Math.pow(0.5, ageMin / a.freshness_half_life_minutes);
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

  const d = t.devBuyPct;
  const devAdj = d >= 0.5 && d <= 4 ? 5 * clamp((d - 0.5) / 1.5) * clamp((4 - d) / 1.5 + 0.34)
               : d > 7 ? -clamp((d - 7) / 8) * 12
               : 0;

  const walletsLive = walletsTracked();
  const scale = walletsLive ? 1 : 100 / (100 - w.smart_money);
  const directed = (key: keyof RawScoreFeatures) => getDirection(key) < 0 ? 1 - raw[key] : raw[key];

  const freshnessScore = directed('freshness') * w.freshness * scale;
  const velocityScore = directed('velocity') * w.velocity * scale;
  const pressureScore = directed('buy_pressure') * w.buy_pressure * scale;
  const organicScore = directed('organic') * w.organic * scale;
  const socialScore = directed('social') * w.social * scale;
  const smartScore = directed('smart_money') * w.smart_money * (walletsLive ? 1 : 0);

  t.subs = {
    freshness: round1(freshnessScore),
    liquidity: round1(velocityScore),
    buyPressure: round1(pressureScore),
    holderGrowth: round1(organicScore + socialScore),
    smartMoney: round1(smartScore),
    raw,
  };

  let gradBonus = 0;
  if (t.dex === 'pumpfun' && t.curveSol > 0 && t.curveSol >= GRADUATION_SOL * 0.8 && t.curveSol <= GRADUATION_SOL * 1.02) {
    const ref = t.curveSamples.find(cs => Date.now() - cs.at >= 3 * 60_000);
    if (!ref || t.curveSol >= ref.sol)
      gradBonus = ls.graduation_bonus_max * Math.min(1, (t.curveSol - GRADUATION_SOL * 0.8) / (GRADUATION_SOL * 0.2));
  }
  const hourUtc = new Date(t.firstSeen).getUTCHours();
  const deadPenalty = ls.dead_hours_utc.includes(hourUtc) ? ls.dead_hours_penalty : 0;
  const aiDelta = t.aiConviction?.delta || 0;
  const repDelta = t.deployerRep?.delta || 0;
  const total = freshnessScore + velocityScore + pressureScore + organicScore + socialScore + smartScore
    + devAdj + gradBonus + aiDelta + repDelta - deadPenalty;

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
  const velocity = (arr: typeof cs) => {
    if (arr.length < 2) return 0;
    const minutes = (arr[arr.length - 1].at - arr[0].at) / 60000;
    return minutes > 0 ? (arr[arr.length - 1].sol - arr[0].sol) / minutes : 0;
  };
  return velocity(recent) - velocity(prior);
}

export function scoreRawVector(raw: RawScoreFeatures, weights: Record<string, number>, directions: Record<string, number>): number {
  const keys: (keyof RawScoreFeatures)[] = ['freshness', 'velocity', 'buy_pressure', 'organic', 'social', 'smart_money'];
  return keys.reduce((sum, key) => {
    const value = (directions[key] ?? 1) < 0 ? 1 - raw[key] : raw[key];
    return sum + value * Number(weights[key] || 0);
  }, 0);
}

const clamp = (x: number) => Math.min(1, Math.max(0, x));
const round1 = (x: number) => Math.round(x * 10) / 10;
