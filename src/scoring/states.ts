import { cfg } from '../config';
import { TokenRecord } from '../types';
import { getStreamMode } from '../ingest/pumpfun';
import { passesPersistence } from './persistence';
import { CURVE_FILLED_SOL } from '../constants';
import { decisionAllowsRecommendation } from '../model/ensemble';
import { recommendationEligibleSource } from '../model/version';

const autopsy = {
  since: Date.now(), aboveFloor: 0, buy_ratio: 0, evidence: 0,
  persistence: 0, dying: 0, quarantine: 0, model_abstain: 0,
};
const autopsyCoins = new Set<string>();
export function triggerAutopsy() {
  return {
    windowMin: Math.round((Date.now() - autopsy.since) / 60_000), coins: autopsyCoins.size,
    checks: autopsy.aboveFloor, buy_ratio: autopsy.buy_ratio, evidence: autopsy.evidence,
    persistence: autopsy.persistence, dying: autopsy.dying, quarantine: autopsy.quarantine,
    model_abstain: autopsy.model_abstain,
  };
}

function evidenceFloor(token: TokenRecord, states: ReturnType<typeof cfg>['states']): boolean {
  if (getStreamMode() === 'lite') return token.buys5m + token.sells5m >= states.trigger_min_trades;
  return token.totalBuys + token.totalSells >= states.trigger_min_trades
    && token.uniqueBuyers.length >= states.trigger_min_unique_buyers;
}
function earlyRunner(token: TokenRecord, states: ReturnType<typeof cfg>['states']): boolean {
  if (!states.early_runner_enabled) return false;
  const ageMin = (Date.now() - token.firstSeen) / 60_000;
  if (ageMin < states.early_runner_min_age) return false;
  const breadth = getStreamMode() === 'lite'
    ? token.buys5m + token.sells5m >= states.early_runner_min_trades
    : token.uniqueBuyers.length >= states.early_runner_min_buyers;
  const bleeding = token.dex === 'pumpfun' && token.peakCurveSol > CURVE_FILLED_SOL && token.curveSol < token.peakCurveSol * 0.9;
  return breadth && !bleeding;
}

export interface TriggerAssessment {
  ready: boolean;
  blockers: string[];
  buyRatio: number;
  movedPct: number;
  evidenceReady: boolean;
  persistenceReady: boolean;
  tooLate: boolean;
  sourceEligible: boolean;
  modelAllows: boolean;
}

/**
 * One authoritative trigger assessment used by the state machine and diagnostics.
 * A fast runner can still trigger while the entry is inside the configured extension
 * ceiling; once it is beyond that ceiling it remains observation-only.
 */
export function assessTrigger(token: TokenRecord, now = Date.now()): TriggerAssessment {
  const states = cfg().states;
  const buyRatio = token.sells5m > 0 ? token.buys5m / token.sells5m : token.buys5m > 0 ? 3 : 1;
  const movedPct = token.firstScorePrice && token.priceUsd > 0
    ? (token.priceUsd / token.firstScorePrice - 1) * 100 : 0;
  const sourceEligible = recommendationEligibleSource(token.source);
  const modelAllows = decisionAllowsRecommendation(token, now);
  const evidenceReady = evidenceFloor(token, states);
  const persistenceReady = passesPersistence(token, now) || earlyRunner(token, states);
  const tooLate = !token.triggeredAt && movedPct >= states.extended_pct;
  const blockers: string[] = [];

  if (!sourceEligible) blockers.push('source is research-only');
  if (!modelAllows) blockers.push('model enforcement abstained');
  if (token.score < states.trigger_score_min) blockers.push(`score ${token.score.toFixed(1)} < ${states.trigger_score_min}`);
  if (buyRatio < states.trigger_buy_ratio_min) blockers.push(`buy/sell ${buyRatio.toFixed(2)} < ${states.trigger_buy_ratio_min}`);
  if (!evidenceReady) blockers.push('not enough trade/buyer evidence');
  if (!persistenceReady) blockers.push('waiting for persistence');
  if (tooLate) blockers.push(`already extended +${movedPct.toFixed(0)}%`);

  return {
    ready: blockers.length === 0,
    blockers,
    buyRatio,
    movedPct,
    evidenceReady,
    persistenceReady,
    tooLate,
    sourceEligible,
    modelAllows,
  };
}

export function updateState(token: TokenRecord): TokenRecord['state'] | null {
  const states = cfg().states;
  const age = cfg().age;
  const previous = token.state;
  const ageMin = (Date.now() - token.firstSeen) / 60_000;
  const assessment = assessTrigger(token);

  let next: TokenRecord['state'] = previous;
  if (ageMin > age.max_token_age_minutes) next = 'DEAD';
  else if (token.insiderKilled
      || (token.peakScore - token.score >= states.dying_score_drop && token.peakScore >= states.heating_score_min)
      || (assessment.buyRatio <= states.dying_buy_ratio_max && ageMin > 10)
      || (token.dex === 'pumpfun' && token.peakCurveSol > CURVE_FILLED_SOL && token.curveSol < token.peakCurveSol * 0.85)) next = 'DYING';
  else if (assessment.ready) next = 'TRIGGER';
  else if (assessment.tooLate) next = 'EXTENDED';
  else if (token.score >= states.heating_score_min) next = 'HEATING';
  else next = 'WATCHING';

  if (token.gated === true && token.score >= states.trigger_score_min && next !== 'TRIGGER'
      && previous !== 'TRIGGER' && previous !== 'EXTENDED') {
    if (Date.now() - autopsy.since > 3_600_000) {
      autopsy.since = Date.now();
      autopsy.aboveFloor = autopsy.buy_ratio = autopsy.evidence = 0;
      autopsy.persistence = autopsy.dying = autopsy.quarantine = autopsy.model_abstain = 0;
      autopsyCoins.clear();
    }
    autopsy.aboveFloor++; autopsyCoins.add(token.ca);
    if (!assessment.sourceEligible) autopsy.quarantine++;
    else if (!assessment.modelAllows) autopsy.model_abstain++;
    else if (next === 'DYING') autopsy.dying++;
    else {
      if (assessment.buyRatio < states.trigger_buy_ratio_min) autopsy.buy_ratio++;
      if (!assessment.evidenceReady) autopsy.evidence++;
      if (!assessment.persistenceReady) autopsy.persistence++;
    }
  }
  if (next !== previous) {
    token.state = next;
    token.stateChangedAt = Date.now();
    return next;
  }
  return null;
}
