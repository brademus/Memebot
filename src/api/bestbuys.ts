import { cfg } from '../config';
import { passesPersistence } from '../scoring/persistence';
import { activeTokens, getToken } from '../store';
import { rankToken } from '../scoring/rank';
import { TokenRecord } from '../types';
import { weightedSmartHits } from '../wallets/tracker';
import { GRADUATION_SOL } from '../constants';
import { openPaper, PaperSignal } from '../paper/paper';
import { recommendationEligibleSource } from '../model/version';
import { decisionAllowsRecommendation } from '../model/ensemble';

function smartStats(token: TokenRecord, config: ReturnType<typeof cfg>['bestbuys']) {
  return weightedSmartHits(token.smartHits, config.smart_lane_window_min * 60_000);
}
function smartCount(token: TokenRecord, config: ReturnType<typeof cfg>['bestbuys']): number { return smartStats(token, config).weight; }
export function isSecondWaveRetrace(price: number, peak: number, minRetrace: number, maxRetrace: number): boolean {
  if (!(price > 0) || !(peak > 0)) return false;
  const retrace = 1 - price / peak;
  return retrace >= minRetrace && retrace <= maxRetrace;
}

function hasSocial(token: TokenRecord): boolean {
  return !!(token.socials.tg || token.socials.x || token.socials.web);
}
function cleanBundle(token: TokenRecord, config: ReturnType<typeof cfg>['bestbuys']): boolean {
  if (!token.bundle) return false;
  return token.bundle.fundedSnipers === 0
    && (token.bundle.clusterPct ?? token.bundle.insiderPct) <= config.max_cluster_pct;
}
export function hasIndependentOpportunityConfirmation(token: TokenRecord, config = cfg().bestbuys): boolean {
  return hasSocial(token) || cleanBundle(token, config) || smartCount(token, config) >= 1;
}

interface Slot { ca: string; enteredAt: number; peakScore: number; lane: 'organic' | 'smart' | 'pregrad' | 'secondwave' }
const slots: Slot[] = [];
const droppedAt = new Map<string, number>();
const recommendationCandidates = () => activeTokens().filter(token => recommendationEligibleSource(token.source) && decisionAllowsRecommendation(token));
const decisionStrength = (token: TokenRecord) => (token.modelDecision?.expectedValue || 0) * 4
  + (token.modelDecision?.cohortPercentile || 0) * 2 + (token.modelDecision?.targetBeforeStopProbability || 0)
  + token.score / 100;

export function currentBestBuys() {
  const config = cfg().bestbuys;
  const now = Date.now();
  const pruneBefore = now - config.reentry_cooldown_min * 60_000 * 2;
  for (const [ca, at] of droppedAt) if (at < pruneBefore) droppedAt.delete(ca);

  for (let index = slots.length - 1; index >= 0; index--) {
    const slot = slots[index];
    const token = getToken(slot.ca);
    let reason: string | null = null;
    if (!token || token.state === 'DEAD' || !decisionAllowsRecommendation(token)) reason = 'gone or model abstained';
    else {
      const rank = rankToken(token);
      slot.peakScore = Math.max(slot.peakScore, token.score);
      const retrace = token.gradPeak > 0 ? 1 - token.priceUsd / token.gradPeak : 0;
      if (token.bundle && token.bundle.fundedSnipers > 0) reason = 'insider detected';
      else if (token.insiderKilled) reason = 'insider detected';
      else if (token.state === 'DYING') reason = 'momentum died';
      else if (token.score < (slot.lane === 'smart' ? config.smart_lane_exit_score : config.exit_score)) reason = `score fell to ${token.score}`;
      else if (slot.lane === 'organic' && (rank.grade === 'C' || rank.grade === 'D')) reason = `degraded to ${rank.grade}`;
      else if (slot.lane === 'organic' && (rank.timing === 'LATE' || rank.timing === 'STALE')) reason = 'entry window closed';
      else if (slot.lane === 'smart' && smartCount(token, config) === 0) reason = 'smart wallets exited window';
      else if (slot.lane === 'pregrad' && token.dex !== 'pumpfun') reason = 'graduated — catalyst played out';
      else if (slot.lane === 'pregrad' && token.peakCurveSol > 34 && token.curveSol < token.peakCurveSol * 0.85) reason = 'curve reversed before graduation';
      else if (slot.lane === 'secondwave' && retrace > config.secondwave_max_retrace) reason = 'dumped through configured retrace floor';
      else if (slot.lane === 'secondwave' && token.priceUsd >= token.gradPeak * 1.5) reason = 'recovered 1.5x — second wave played out';
      else if (token.devBuyPct > config.max_dev_pct) reason = 'dev bag grew';
      else if (token.dex === 'pumpfun' && token.earlyBuyers.length >= 5 && (1 - token.earlyExited.length / token.earlyBuyers.length) < config.min_retention) reason = 'early buyers dumping';
      else if (token.dex === 'pumpfun' && token.peakCurveSol > 34 && token.curveSol < token.peakCurveSol * 0.85) reason = 'curve outflow';
    }
    if (reason) { droppedAt.set(slot.ca, now); slots.splice(index, 1); }
  }

  const inSlots = new Set(slots.map(slot => slot.ca));
  const organicSlots = () => slots.filter(slot => slot.lane === 'organic');
  const cooldownMs = config.reentry_cooldown_min * 60_000;
  const candidates = recommendationCandidates()
    .filter(token => !inSlots.has(token.ca) && (droppedAt.get(token.ca) || 0) < now - cooldownMs)
    .filter(token => passesPersistence(token, now))
    .map(token => ({ token, rank: rankToken(token) }))
    .filter(({ token, rank }) => ['A+', 'A', 'B'].includes(rank.grade) && ['EARLY', 'FAIR'].includes(rank.timing)
      && token.score >= config.min_score
      && Math.max(token.totalBuys + token.totalSells, token.buys5m + token.sells5m) >= config.min_trades
      && (token.uniqueBuyers.length >= config.min_unique_buyers || token.buys5m >= config.min_unique_buyers)
      && (token.dex !== 'pumpfun' || token.curveSol >= config.min_curve_sol)
      && token.devBuyPct <= config.max_dev_pct && hasIndependentOpportunityConfirmation(token, config)
      && (!config.require_social || hasSocial(token))
      && (!token.bundle || token.bundle.fundedSnipers === 0))
    .sort((left, right) => decisionStrength(right.token) - decisionStrength(left.token));

  for (const { token } of candidates) {
    if (organicSlots().length < config.max_shown) {
      slots.push({ ca: token.ca, enteredAt: now, peakScore: token.score, lane: 'organic' });
      inSlots.add(token.ca);
    } else {
      const organic = organicSlots();
      const weakest = organic.reduce((minimum, slot) => decisionStrength(getToken(slot.ca)!) < decisionStrength(getToken(minimum.ca)!) ? slot : minimum, organic[0]);
      const incumbent = getToken(weakest.ca);
      const heldSeconds = (now - weakest.enteredAt) / 1000;
      if (incumbent && heldSeconds >= config.min_hold_seconds && decisionStrength(token) > decisionStrength(incumbent) + 0.25) {
        droppedAt.set(weakest.ca, now); slots.splice(slots.indexOf(weakest), 1); inSlots.delete(weakest.ca);
        slots.push({ ca: token.ca, enteredAt: now, peakScore: token.score, lane: 'organic' }); inSlots.add(token.ca);
      }
    }
  }

  if (config.smart_lane && !slots.some(slot => slot.lane === 'smart')) {
    const smart = recommendationCandidates()
      .filter(token => !inSlots.has(token.ca) && (droppedAt.get(token.ca) || 0) < now - cooldownMs)
      .filter(token => token.gated === true && !token.insiderKilled && !['DYING','DEAD','EXTENDED'].includes(token.state))
      .filter(token => (!token.bundle || token.bundle.fundedSnipers === 0) && token.devBuyPct <= config.max_dev_pct)
      .filter(token => (now - token.firstSeen) / 60_000 >= config.smart_lane_min_age_min && token.score >= config.smart_lane_min_score)
      .filter(token => !(token.dex === 'pumpfun' && token.peakCurveSol > 34 && token.curveSol < token.peakCurveSol * 0.9))
      .map(token => ({ token, count: smartCount(token, config) }))
      .filter(({ count }) => count >= config.smart_lane_min_wallets)
      .sort((left, right) => decisionStrength(right.token) - decisionStrength(left.token) || right.count - left.count);
    if (smart.length) { slots.push({ ca: smart[0].token.ca, enteredAt: now, peakScore: smart[0].token.score, lane: 'smart' }); inSlots.add(smart[0].token.ca); }
  }

  if (config.pregrad_lane && !slots.some(slot => slot.lane === 'pregrad')) {
    const near = recommendationCandidates()
      .filter(token => !inSlots.has(token.ca) && (droppedAt.get(token.ca) || 0) < now - cooldownMs)
      .filter(token => token.gated === true && !token.insiderKilled && token.dex === 'pumpfun' && token.curveSol > 0)
      .filter(token => !['DYING','DEAD'].includes(token.state) && (!token.bundle || token.bundle.fundedSnipers === 0) && token.devBuyPct <= config.max_dev_pct)
      .filter(token => token.curveSol >= GRADUATION_SOL * config.pregrad_min_pct && token.curveSol < GRADUATION_SOL)
      .map(token => { const reference = token.curveSamples.find(sample => now - sample.at >= 180_000); return { token, climbing: !reference || token.curveSol > reference.sol }; })
      .filter(({ climbing }) => climbing)
      .sort((left, right) => decisionStrength(right.token) - decisionStrength(left.token));
    if (near.length) { slots.push({ ca: near[0].token.ca, enteredAt: now, peakScore: near[0].token.score, lane: 'pregrad' }); inSlots.add(near[0].token.ca); }
  }

  if (config.secondwave_lane && !slots.some(slot => slot.lane === 'secondwave')) {
    const wave = recommendationCandidates()
      .filter(token => !inSlots.has(token.ca) && (droppedAt.get(token.ca) || 0) < now - cooldownMs)
      .filter(token => token.gated === true && !token.insiderKilled && !!token.gradAt && token.dex === 'pumpswap')
      .filter(token => now - (token.gradAt || 0) < config.secondwave_max_age_min * 60_000 && (token.fillMinutes ?? 0) >= config.secondwave_min_fill_min)
      .filter(token => isSecondWaveRetrace(token.priceUsd, token.gradPeak, config.secondwave_min_retrace, config.secondwave_max_retrace))
      .filter(token => !token.bundle || (token.bundle.clusterPct ?? token.bundle.insiderPct) <= config.max_cluster_pct)
      .filter(token => (token.deployerRep?.cls ?? 'KNOWN') !== 'SERIAL_DEAD' && smartCount(token, config) >= 1 && !['DYING','DEAD'].includes(token.state))
      .sort((left, right) => decisionStrength(right) - decisionStrength(left));
    if (wave.length) { wave[0].secondWaveAt = now; slots.push({ ca: wave[0].ca, enteredAt: now, peakScore: wave[0].score, lane: 'secondwave' }); inSlots.add(wave[0].ca); }
  }

  for (const slot of slots) if (slot.enteredAt === now) {
    const token = getToken(slot.ca);
    if (token && token.priceUsd > 0) void openPaper(token.ca, token.symbol, (`bb_${slot.lane}`) as PaperSignal, token.priceUsd, token.score, token.modelDecision?.execution || undefined)
      .catch(error => console.error('[bestbuys:paper]', (error as Error).message));
  }

  return slots.slice().sort((left, right) => left.enteredAt - right.enteredAt).map(slot => {
    const token = getToken(slot.ca)!; const rank = rankToken(token); const smart = smartStats(token, config); const model = token.modelDecision;
    return {
      ca: token.ca, symbol: token.symbol, grade: rank.grade, timing: rank.timing, lane: slot.lane,
      label: model
        ? `${rank.label} · v3 ${(model.targetBeforeStopProbability * 100).toFixed(1)}% target-before-loss · ${(model.cohortPercentile * 100).toFixed(0)}th percentile`
        : `${rank.label} · v3 evidence collecting`,
      confidence: rank.confidence, score: token.score, peakScore: slot.peakScore,
      heldMin: Math.round((now - slot.enteredAt) / 60_000), cautions: rank.cautions,
      liq: Math.round(token.liquidityUsd), buys: token.buys5m, sells: token.sells5m,
      smart: smart.wallets, smartElite: smart.elite, pair: token.pairAddress,
      model: model ? { version: model.modelVersion, targetBeforeStop: model.targetBeforeStopProbability,
        downside: model.downsideProbability, expectedValue: model.expectedValue, uncertainty: model.uncertainty,
        percentile: model.cohortPercentile, regime: model.regime.kind, execution: model.execution } : null,
    };
  });
}
