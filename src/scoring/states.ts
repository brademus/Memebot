import { cfg } from '../config';
import { TokenRecord } from '../types';
import { getStreamMode } from '../ingest/pumpfun';

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
             ((t.priceUsd / t.firstScorePrice) - 1) * 100 >= s.extended_pct) {
    next = 'EXTENDED';                                 // already ran — you'd be exit liquidity
  } else if ((t.peakScore - t.score >= s.dying_score_drop && t.peakScore >= s.heating_score_min) ||
             (buyRatio <= s.dying_buy_ratio_max && ageMin > 10) ||
             // curve outflow: SOL leaving the curve = holders cashing out = distribution.
             // >15% off the high-water mark (once meaningfully filled) is a death signal.
             (t.dex === 'pumpfun' && t.peakCurveSol > 34 && t.curveSol < t.peakCurveSol * 0.85)) {
    next = 'DYING';                                    // rollover — rotate attention away
  } else if (t.score >= s.trigger_score_min && buyRatio >= s.trigger_buy_ratio_min
             && evidenceFloor(t, s)) {
    next = 'TRIGGER';                                  // decision time
  } else if (t.score >= s.heating_score_min) {
    next = 'HEATING';                                  // open the chart
  } else {
    next = 'WATCHING';
  }

  if (next !== prev) {
    t.state = next;
    t.stateChangedAt = Date.now();
    return next;
  }
  return null;
}
