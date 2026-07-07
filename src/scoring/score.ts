import { cfg } from '../config';
import { TokenRecord } from '../types';
import { walletsTracked } from '../wallets/tracker';

// SCORING v2 — curve-native, continuous.
// Built on the validated finding that SOL accumulated in the bonding curve is the
// state variable that best summarizes demand, and its VELOCITY is the live signal.
// Every sub-score is a smooth 0..1, so scores spread across the whole range
// instead of collapsing to a few discrete values.
//
// Signals (weights from config):
//   freshness      exponential age decay (0-4h window)
//   liquidity      CURVE: progress toward graduation (~85 SOL) + inflow velocity
//                  AMM:   liq/mcap ratio + absolute depth (original model)
//   buy_pressure   volume-damped buys:sells — 1:0 on 1 txn is noise, 30:10 is signal
//   holder_growth  distinct buyer wallets, log-scaled + recent-growth slope
//   smart_money    tracked-wallet hits (unchanged; redistributed until wallets exist)

const GRADUATION_SOL = 85;     // pump.fun curve completes ~85 SOL
const CURVE_START_SOL = 30;    // virtual reserves start ~30 SOL

export function scoreToken(t: TokenRecord): number {
  const w = cfg().weights;
  const a = cfg().age;
  const onCurve = t.dex === 'pumpfun';

  // ---- freshness: exponential decay ----
  const ageMin = (Date.now() - t.firstSeen) / 60000;
  const freshness = Math.pow(0.5, ageMin / a.freshness_half_life_minutes);

  // ---- liquidity / demand ----
  let liquidity: number;
  if (onCurve) {
    // progress: how far along the curve (30 -> 85 SOL), smooth 0..1
    const progress = clamp((t.curveSol - CURVE_START_SOL) / (GRADUATION_SOL - CURVE_START_SOL));
    // velocity: SOL/min flowing in over the last ~2 min of samples, saturating at 3 SOL/min
    const velocity = clamp(curveVelocity(t) / 3);
    // demand blend: velocity is the live edge, progress is accumulated proof
    liquidity = 0.6 * velocity + 0.4 * progress;
  } else {
    const ratio = t.mcapUsd > 0 ? t.liquidityUsd / t.mcapUsd : 0;
    const ratioScore = clamp((ratio - 0.08) / 0.25);
    const depthScore = clamp(Math.log10(Math.max(t.liquidityUsd, 1) / 12000) / Math.log10(150000 / 12000));
    liquidity = 0.5 * ratioScore + 0.5 * depthScore;
  }

  // ---- buy pressure: ratio damped by transaction volume ----
  // ratio alone saturates on 1:0; weight it by how much evidence exists.
  const txns = t.buys5m + t.sells5m;
  const ratioRaw = (t.buys5m + 1) / (t.sells5m + 1);              // Laplace-smoothed
  const ratioScore = clamp((ratioRaw - 1) / 2);                    // 1x -> 0, 3x+ -> 1
  const volumeWeight = clamp(Math.log(1 + txns) / Math.log(1 + 25)); // ~25 txns = full confidence
  const buyPressure = ratioScore * volumeWeight;

  // ---- holder growth: distinct buyers (log scale) + short-window growth ----
  const uniq = t.uniqueBuyers.length;
  const uniqScore = clamp(Math.log(1 + uniq) / Math.log(1 + 80));  // 80 distinct buyers = max
  const s = t.uniqueBuyerSamples;
  const slope = s.length >= 3 ? clamp((s[s.length - 1] - s[0]) / (s.length * 5)) : 0;
  const holderGrowth = 0.7 * uniqScore + 0.3 * slope;

  // ---- smart money ----
  const winMs = cfg().wallets.hit_recency_hours * 3600_000;
  const hits = new Set(t.smartHits.filter(h => Date.now() - h.at < winMs).map(h => h.wallet)).size;
  const smartMoney = Math.min(1, hits / 3);

  // ---- dev-bag penalty: deployer holding a big % is structural dump risk ----
  // smooth penalty: 0 below 4%, scaling to -12 points at 15%+
  const devPenalty = clamp((t.devBuyPct - 4) / 11) * 12;

  const walletsLive = walletsTracked();
  const scale = walletsLive ? 1 : 100 / (100 - w.smart_money);

  t.subs = {
    freshness: round1(freshness * w.freshness * scale),
    liquidity: round1(liquidity * w.liquidity_health * scale),
    buyPressure: round1(buyPressure * w.buy_pressure * scale),
    holderGrowth: round1(holderGrowth * w.holder_growth * scale),
    smartMoney: round1(smartMoney * w.smart_money * (walletsLive ? 1 : 0)),
  };
  const total = t.subs.freshness + t.subs.liquidity + t.subs.buyPressure + t.subs.holderGrowth + t.subs.smartMoney - devPenalty;
  t.score = round1(Math.max(0, total));
  if (t.score > t.peakScore) t.peakScore = t.score;
  if (t.firstScorePrice === null && t.priceUsd > 0) t.firstScorePrice = t.priceUsd;
  return t.score;
}

function curveVelocity(t: TokenRecord): number {
  const cs = t.curveSamples;
  if (cs.length < 2) return 0;
  const recent = cs.filter(x => Date.now() - x.at < 120_000);
  if (recent.length < 2) return 0;
  const dSol = recent[recent.length - 1].sol - recent[0].sol;
  const dMin = (recent[recent.length - 1].at - recent[0].at) / 60000;
  return dMin > 0 ? Math.max(0, dSol / dMin) : 0;
}

const clamp = (x: number) => Math.min(1, Math.max(0, x));
const round1 = (x: number) => Math.round(x * 10) / 10;
