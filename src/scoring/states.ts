import { cfg } from '../config';
import { TokenRecord } from '../types';
import { getStreamMode } from '../ingest/pumpfun';
import { passesPersistence } from './persistence';

// TRIGGER AUTOPSY — turns "why are there no triggers" into named numbers. Every
// evaluation where a gated coin scores ABOVE the floor but does NOT trigger is
// attributed to the condition that blocked it (rolling 60min window). If coins
// never even reach the floor, aboveFloor stays 0 and the problem is the SCORE;
// if aboveFloor is high and one blocker dominates, THAT condition is the choke.
const autopsy = { since: Date.now(), aboveFloor: 0, buy_ratio: 0, evidence: 0, persistence: 0, dying: 0 };
const autopsyCoins = new Set<string>();
export function triggerAutopsy() {
  return { windowMin: Math.round((Date.now() - autopsy.since) / 60_000), coins: autopsyCoins.size,
           checks: autopsy.aboveFloor, buy_ratio: autopsy.buy_ratio, evidence: autopsy.evidence,
           persistence: autopsy.persistence, dying: autopsy.dying };
}
import { CURVE_FILLED_SOL } from '../constants';

// State machine. Returns the new state if it changed, else null.
// Order matters: kill conditions (EXTENDED/DYING/DEAD) evaluated before promotions.
function evidenceFloor(t: TokenRecord, s: ReturnType<typeof cfg>['states']): boolean {
  if (getStreamMode() === 'lite') {
    // no per-trade wallet data on free tier — floor on Dexscreener 5m activity
    return (t.buys5m + t.sells5m) >= s.trigger_min_trades;
  }
  return (t.totalBuys + t.totalSells) >= s.trigger_min_trades
      && t.uniqueBuyers.length >= s.trigger_min_unique_buyers;
}

// A fast coin with genuine breadth shouldn't wait out the full anti-snipe age gate
// only to hit EXTENDED first. If enough DISTINCT buyers are in and the ratio is
// strong, it's organic momentum, not a 2-wallet sniper pump — let it trigger early.
// Still subject to all death branches (insider/dying/curve-dump) evaluated above.
function earlyRunner(t: TokenRecord, s: ReturnType<typeof cfg>['states']): boolean {
  if (!s.early_runner_enabled) return false;
  const ageMin = (Date.now() - t.firstSeen) / 60000;
  if (ageMin < s.early_runner_min_age) return false;   // still a floor, just lower than 4min
  const breadth = getStreamMode() === 'lite'
    ? (t.buys5m + t.sells5m) >= s.early_runner_min_trades
    : t.uniqueBuyers.length >= s.early_runner_min_buyers;
  // curve must not be actively bleeding (the one persistence check we keep)
  const bleeding = t.dex === 'pumpfun' && t.peakCurveSol > CURVE_FILLED_SOL && t.curveSol < t.peakCurveSol * 0.9;
  return breadth && !bleeding;
}

export function updateState(t: TokenRecord): TokenRecord['state'] | null {
  const s = cfg().states;
  const a = cfg().age;
  const prev = t.state;
  const ageMin = (Date.now() - t.firstSeen) / 60000;
  const buyRatio = t.sells5m > 0 ? t.buys5m / t.sells5m : (t.buys5m > 0 ? 3 : 1);

  let next: TokenRecord['state'] = prev;

  if (ageMin > a.max_token_age_minutes) {
    next = 'DEAD';                                     // out of the 4h window — off the screen, stays in DB
  } else if (t.firstScorePrice && t.priceUsd > 0 &&
             ((t.priceUsd / t.firstScorePrice) - 1) * 100 >= s.extended_pct &&
             !t.triggeredAt) {
    // "already ran" only locks out coins we never called. Once a coin has TRIGGERED,
    // a big move is the WIN we're riding (the ladder handles take-profit), not a
    // reason to eject. Fast pre-trigger runners still gate out — but see the
    // early-runner carve-out below, which lets a clean fast mover trigger first.
    next = 'EXTENDED';                                 // ran up before we ever called it — you'd be exit liquidity
  } else if (t.insiderKilled ||
             (t.peakScore - t.score >= s.dying_score_drop && t.peakScore >= s.heating_score_min) ||
             (buyRatio <= s.dying_buy_ratio_max && ageMin > 10) ||
             // curve outflow: SOL leaving the curve = holders cashing out = distribution.
             // >15% off the high-water mark (once meaningfully filled) is a death signal.
             (t.dex === 'pumpfun' && t.peakCurveSol > CURVE_FILLED_SOL && t.curveSol < t.peakCurveSol * 0.85)) {
    next = 'DYING';                                    // rollover — rotate attention away
  } else if (t.score >= s.trigger_score_min && buyRatio >= s.trigger_buy_ratio_min
             && evidenceFloor(t, s)
             && (passesPersistence(t) || earlyRunner(t, s))) {
    next = 'TRIGGER';                                  // decision time
  } else if (t.score >= s.heating_score_min) {
    next = 'HEATING';                                  // open the chart
  } else {
    next = 'WATCHING';
  }

  // autopsy: gated, above floor, didn't trigger — who blocked it?
  if (t.gated === true && t.score >= s.trigger_score_min && next !== 'TRIGGER'
      && prev !== 'TRIGGER' && prev !== 'EXTENDED') {
    if (Date.now() - autopsy.since > 3600_000) {
      autopsy.since = Date.now(); autopsy.aboveFloor = autopsy.buy_ratio = autopsy.evidence = autopsy.persistence = autopsy.dying = 0;
      autopsyCoins.clear();
    }
    autopsy.aboveFloor++; autopsyCoins.add(t.ca);
    if (next === 'DYING') autopsy.dying++;
    else {
      if (buyRatio < s.trigger_buy_ratio_min) autopsy.buy_ratio++;
      if (!evidenceFloor(t, s)) autopsy.evidence++;
      if (!(passesPersistence(t) || earlyRunner(t, s))) autopsy.persistence++;
    }
  }

  if (next !== prev) {
    t.state = next;
    t.stateChangedAt = Date.now();
    return next;
  }
  return null;
}
