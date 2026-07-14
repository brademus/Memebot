import { cfg } from '../config';
import { TokenRecord } from './../types';
import { passesPersistence } from './persistence';
import { weightedSmartHits } from '../wallets/tracker';
import { decisionAllowsRecommendation } from '../model/ensemble';

export interface ConvictionResult { pass: boolean; confirmed: string[]; missing: string[] }
let dayKey = '';
let firedToday = 0;
function budgetLeft(max: number): boolean {
  const key = new Date().toISOString().slice(0, 10);
  if (key !== dayKey) { dayKey = key; firedToday = 0; }
  return firedToday < max;
}
export function consumeBudget() { firedToday++; }
export const convictionFiredToday = () => firedToday;

export function checkConviction(token: TokenRecord, now = Date.now()): ConvictionResult {
  const config = cfg().conviction;
  const bundle = cfg().bundle;
  const confirmed: string[] = [];
  const missing: string[] = [];
  if (!config?.enabled) return { pass: false, confirmed, missing: ['conviction disabled'] };

  if (token.state !== 'TRIGGER') missing.push('not in TRIGGER');
  if (token.score < config.min_score) missing.push(`score ${token.score} < ${config.min_score}`);
  else confirmed.push(`legacy filter score ${token.score}`);

  if (!decisionAllowsRecommendation(token, now)) missing.push('v3 model abstained or decision expired');
  else if (token.modelDecision) {
    confirmed.push(`v3 ${(token.modelDecision.targetBeforeStopProbability * 100).toFixed(1)}% target-before-loss`);
    confirmed.push(`${(token.modelDecision.cohortPercentile * 100).toFixed(0)}th percentile in ${token.modelDecision.regime.kind} regime`);
    if (!token.modelDecision.execution?.simulationOk) missing.push('entry transaction not simulated');
    else confirmed.push(`entry simulation passed (${token.modelDecision.execution.executionScore.toFixed(2)} execution score)`);
  }

  const heldSeconds = (now - token.stateChangedAt) / 1000;
  if (token.state === 'TRIGGER' && heldSeconds >= config.min_trigger_hold_seconds) confirmed.push(`held TRIGGER ${Math.round(heldSeconds)}s`);
  else missing.push(`trigger hold ${Math.round(heldSeconds)}s < ${config.min_trigger_hold_seconds}s`);

  if (config.require_clean_bundle) {
    if (token.insiderKilled) missing.push('insider-killed');
    else if (token.bundle === null) missing.push('entity graph unverified');
    else if (token.bundle.fundedSnipers > 0) missing.push(`${token.bundle.fundedSnipers} funded snipers`);
    else if ((token.bundle.clusterPct ?? token.bundle.insiderPct) > bundle.max_insider_supply_pct)
      missing.push(`entity cluster ${(token.bundle.clusterPct ?? token.bundle.insiderPct).toFixed(0)}%`);
    else if (!token.entityGraph?.complete) missing.push('funding entity graph incomplete');
    else confirmed.push(`${token.entityGraph.independentEntities} independent funding entities, graph risk ${token.entityGraph.graphRisk.toFixed(2)}`);
  }

  const smart = weightedSmartHits(token.smartHits, config.smart_wallet_window_min * 60_000, now);
  if (smart.weight >= config.min_smart_wallets)
    confirmed.push(smart.elite ? `${smart.elite} ELITE wallet(s), smart weight ${smart.weight}` : `${smart.wallets} measured smart wallets`);
  else missing.push(`smart weight ${smart.weight}/${config.min_smart_wallets}`);

  if (config.require_social) {
    const members = token.socials.tgMembers;
    const telegramReal = token.socials.tg && (members === null || members >= 25);
    if (telegramReal || token.socials.x) confirmed.push(`socials live (${[telegramReal && 'TG',token.socials.x && 'X',token.socials.web && 'web'].filter(Boolean).join(' + ')})`);
    else missing.push(token.socials.tg ? `TG is a ${members}-member shell, no X` : 'no TG/X');
  }

  if (token.firstScorePrice && token.priceUsd > 0) {
    const ran = (token.priceUsd / token.firstScorePrice - 1) * 100;
    if (ran <= config.max_run_pct) confirmed.push(`moved only ${ran.toFixed(0)}% since first score`);
    else missing.push(`already ran ${ran.toFixed(0)}% > ${config.max_run_pct}%`);
  }
  if (passesPersistence(token, now)) {
    if (token.earlyBuyers.length >= 5)
      confirmed.push(`early-buyer retention ${((1 - token.earlyExited.length / token.earlyBuyers.length) * 100).toFixed(0)}%`);
  } else missing.push('persistence failed at confirm time');
  if (!budgetLeft(config.max_alerts_per_day)) missing.push('daily alert budget spent');
  return { pass: missing.length === 0, confirmed, missing };
}
