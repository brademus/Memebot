import { cfg } from '../config';
import { TokenRecord } from '../types';
import { getStreamMode } from '../ingest/pumpfun';
import { passesPersistence } from './persistence';
import { CURVE_FILLED_SOL } from '../constants';
import { recommendationEligibleSource } from '../model/version';

const autopsy = {
  since: Date.now(), aboveFloor: 0, buy_ratio: 0, evidence: 0,
  persistence: 0, dying: 0, quarantine: 0,
};
const autopsyCoins = new Set<string>();
export function triggerAutopsy() {
  return {
    windowMin: Math.round((Date.now() - autopsy.since) / 60_000),
    coins: autopsyCoins.size,
    checks: autopsy.aboveFloor,
    buy_ratio: autopsy.buy_ratio,
    evidence: autopsy.evidence,
    persistence: autopsy.persistence,
    dying: autopsy.dying,
    quarantine: autopsy.quarantine,
  };
}

function evidenceFloor(t: TokenRecord, states: ReturnType<typeof cfg>['states']): boolean {
  if (getStreamMode() === 'lite') return (t.buys5m + t.sells5m) >= states.trigger_min_trades;
  return (t.totalBuys + t.totalSells) >= states.trigger_min_trades
      && t.uniqueBuyers.length >= states.trigger_min_unique_buyers;
}

function earlyRunner(t: TokenRecord, states: ReturnType<typeof cfg>['states']): boolean {
  if (!states.early_runner_enabled) return false;
  const ageMin = (Date.now() - t.firstSeen) / 60_000;
  if (ageMin < states.early_runner_min_age) return false;
  const breadth = getStreamMode() === 'lite'
    ? (t.buys5m + t.sells5m) >= states.early_runner_min_trades
    : t.uniqueBuyers.length >= states.early_runner_min_buyers;
  const bleeding = t.dex === 'pumpfun' && t.peakCurveSol > CURVE_FILLED_SOL && t.curveSol < t.peakCurveSol * 0.9;
  return breadth && !bleeding;
}

export function updateState(t: TokenRecord): TokenRecord['state'] | null {
  const states = cfg().states;
  const age = cfg().age;
  const previous = t.state;
  const ageMin = (Date.now() - t.firstSeen) / 60_000;
  const buyRatio = t.sells5m > 0 ? t.buys5m / t.sells5m : (t.buys5m > 0 ? 3 : 1);
  const recommendationEligible = recommendationEligibleSource(t.source);

  let next: TokenRecord['state'] = previous;
  if (ageMin > age.max_token_age_minutes) {
    next = 'DEAD';
  } else if (t.firstScorePrice && t.priceUsd > 0
      && ((t.priceUsd / t.firstScorePrice) - 1) * 100 >= states.extended_pct
      && !t.triggeredAt) {
    next = 'EXTENDED';
  } else if (t.insiderKilled
      || (t.peakScore - t.score >= states.dying_score_drop && t.peakScore >= states.heating_score_min)
      || (buyRatio <= states.dying_buy_ratio_max && ageMin > 10)
      || (t.dex === 'pumpfun' && t.peakCurveSol > CURVE_FILLED_SOL && t.curveSol < t.peakCurveSol * 0.85)) {
    next = 'DYING';
  } else if (recommendationEligible
      && t.score >= states.trigger_score_min
      && buyRatio >= states.trigger_buy_ratio_min
      && evidenceFloor(t, states)
      && (passesPersistence(t) || earlyRunner(t, states))) {
    next = 'TRIGGER';
  } else if (t.score >= states.heating_score_min) {
    // Momentum discoveries remain measurable and visible as research candidates but
    // cannot become recommendations until their source has positive forward evidence.
    next = 'HEATING';
  } else {
    next = 'WATCHING';
  }

  if (t.gated === true && t.score >= states.trigger_score_min && next !== 'TRIGGER'
      && previous !== 'TRIGGER' && previous !== 'EXTENDED') {
    if (Date.now() - autopsy.since > 3_600_000) {
      autopsy.since = Date.now();
      autopsy.aboveFloor = autopsy.buy_ratio = autopsy.evidence = 0;
      autopsy.persistence = autopsy.dying = autopsy.quarantine = 0;
      autopsyCoins.clear();
    }
    autopsy.aboveFloor++;
    autopsyCoins.add(t.ca);
    if (!recommendationEligible) autopsy.quarantine++;
    else if (next === 'DYING') autopsy.dying++;
    else {
      if (buyRatio < states.trigger_buy_ratio_min) autopsy.buy_ratio++;
      if (!evidenceFloor(t, states)) autopsy.evidence++;
      if (!(passesPersistence(t) || earlyRunner(t, states))) autopsy.persistence++;
    }
  }

  if (next !== previous) {
    t.state = next;
    t.stateChangedAt = Date.now();
    return next;
  }
  return null;
}
