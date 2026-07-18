import { cfg } from '../config';
import { TokenRecord } from '../types';
import { CURVE_FILLED_SOL } from '../constants';
import {
  assessEntryTiming,
  ConvictionQueueStatus,
  EntryTimingAssessment,
} from './conviction-queue';

const autopsy = {
  since: Date.now(),
  aboveFloor: 0,
  notConvicted: 0,
  convictionHold: 0,
  buyRatio: 0,
  evidence: 0,
  persistence: 0,
  burstTooHot: 0,
  dying: 0,
  modelAbstain: 0,
};
const autopsyCoins = new Set<string>();

export function triggerAutopsy() {
  return {
    windowMin: Math.round((Date.now() - autopsy.since) / 60_000),
    coins: autopsyCoins.size,
    checks: autopsy.aboveFloor,
    notConvicted: autopsy.notConvicted,
    convictionHold: autopsy.convictionHold,
    buyRatio: autopsy.buyRatio,
    evidence: autopsy.evidence,
    persistence: autopsy.persistence,
    burstTooHot: autopsy.burstTooHot,
    dying: autopsy.dying,
    modelAbstain: autopsy.modelAbstain,
  };
}

export function assessTrigger(
  token: TokenRecord,
  now = Date.now(),
  convictionOverride?: ConvictionQueueStatus,
): EntryTimingAssessment {
  return assessEntryTiming(token, now, convictionOverride);
}

export function updateState(
  token: TokenRecord,
  now = Date.now(),
  convictionOverride?: ConvictionQueueStatus,
): TokenRecord['state'] | null {
  const states = cfg().states;
  const age = cfg().age;
  const previous = token.state;
  const ageMin = (now - token.firstSeen) / 60_000;
  const assessment = assessEntryTiming(token, now, convictionOverride);

  let next: TokenRecord['state'] = previous;
  if (ageMin > age.max_token_age_minutes) next = 'DEAD';
  else if (token.insiderKilled
      || (token.peakScore - token.score >= states.dying_score_drop && token.peakScore >= states.heating_score_min)
      || (assessment.buyRatio <= states.dying_buy_ratio_max && ageMin > 10)
      || (token.dex === 'pumpfun' && token.peakCurveSol > CURVE_FILLED_SOL
        && token.curveSol < token.peakCurveSol * 0.85)) next = 'DYING';
  // Once an alert has fired, removing it from the conviction queue must not move the
  // live call backward into HEATING. Paper exits and the dying/dead rules close it.
  else if (previous === 'TRIGGER' && token.triggeredAt) next = 'TRIGGER';
  else if (assessment.ready) next = 'TRIGGER';
  else if (assessment.tooLate) next = 'EXTENDED';
  else if (token.score >= states.heating_score_min || assessment.conviction.queued) next = 'HEATING';
  else next = 'WATCHING';

  if (token.gated === true && token.score >= states.trigger_score_min && next !== 'TRIGGER'
      && previous !== 'TRIGGER' && previous !== 'EXTENDED') {
    if (now - autopsy.since > 3_600_000) {
      autopsy.since = now;
      autopsy.aboveFloor = 0;
      autopsy.notConvicted = 0;
      autopsy.convictionHold = 0;
      autopsy.buyRatio = 0;
      autopsy.evidence = 0;
      autopsy.persistence = 0;
      autopsy.burstTooHot = 0;
      autopsy.dying = 0;
      autopsy.modelAbstain = 0;
      autopsyCoins.clear();
    }
    autopsy.aboveFloor++;
    autopsyCoins.add(token.ca);
    if (!assessment.conviction.queued) autopsy.notConvicted++;
    else if (!assessment.conviction.holdReady) autopsy.convictionHold++;
    if (!assessment.modelAllows) autopsy.modelAbstain++;
    else if (next === 'DYING') autopsy.dying++;
    else {
      if (assessment.buyRatio < states.trigger_buy_ratio_min) autopsy.buyRatio++;
      if (!assessment.evidenceReady) autopsy.evidence++;
      if (!assessment.persistenceReady) autopsy.persistence++;
      if (!assessment.burstCooled) autopsy.burstTooHot++;
    }
  }

  if (next !== previous) {
    token.state = next;
    token.stateChangedAt = now;
    return next;
  }
  return null;
}
