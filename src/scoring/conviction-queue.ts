import { cfg } from '../config';
import { markConviction, upsertToken } from '../db';
import { getStreamMode } from '../ingest/pumpfun';
import { openPaper, PaperSignal } from '../paper/paper';
import { activeTokens, getToken } from '../store';
import { TokenRecord } from '../types';
import { weightedSmartHits } from '../wallets/tracker';
import { GRADUATION_SOL } from '../constants';
import { decisionAllowsRecommendation } from '../model/ensemble';
import { recommendationEligibleSource } from '../model/version';
import { passesPersistence } from './persistence';
import { rankToken } from './rank';

export type ConvictionLane = 'organic' | 'smart' | 'pregrad' | 'secondwave';

interface ConvictionSlot {
  ca: string;
  enteredAt: number;
  peakScore: number;
  lane: ConvictionLane;
}

export interface ConvictionQueueStatus {
  queued: boolean;
  lane: ConvictionLane | null;
  enteredAt: number | null;
  heldSeconds: number;
  minimumHoldSeconds: number;
  holdReady: boolean;
  scoreFloor: number;
}

export interface EntryTimingAssessment {
  ready: boolean;
  blockers: string[];
  conviction: ConvictionQueueStatus;
  buyRatio: number;
  movedPct: number;
  evidenceReady: boolean;
  persistenceReady: boolean;
  burstCooled: boolean;
  tooLate: boolean;
  sourceEligible: boolean;
  modelAllows: boolean;
}

const slots: ConvictionSlot[] = [];
const droppedAt = new Map<string, number>();

function smartStats(token: TokenRecord, config: ReturnType<typeof cfg>['bestbuys']) {
  return weightedSmartHits(token.smartHits, config.smart_lane_window_min * 60_000);
}
function smartCount(token: TokenRecord, config: ReturnType<typeof cfg>['bestbuys']): number {
  return smartStats(token, config).weight;
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
export function isSecondWaveRetrace(price: number, peak: number, minRetrace: number, maxRetrace: number): boolean {
  if (!(price > 0) || !(peak > 0)) return false;
  const retrace = 1 - price / peak;
  return retrace >= minRetrace && retrace <= maxRetrace;
}

const recommendationCandidates = () => activeTokens().filter(token =>
  token.gated === true
  && !token.triggeredAt
  && token.state !== 'TRIGGER'
  && recommendationEligibleSource(token.source)
  && decisionAllowsRecommendation(token));

const decisionStrength = (token: TokenRecord) => (token.modelDecision?.expectedValue || 0) * 4
  + (token.modelDecision?.cohortPercentile || 0) * 2
  + (token.modelDecision?.targetBeforeStopProbability || 0)
  + token.score / 100;

function minimumHoldSeconds(lane: ConvictionLane): number {
  const configured = Math.max(30, cfg().bestbuys.min_hold_seconds);
  if (lane === 'smart') return Math.min(60, configured);
  if (lane === 'pregrad' || lane === 'secondwave') return Math.min(90, configured);
  return configured;
}

function scoreFloor(lane: ConvictionLane): number {
  const config = cfg().bestbuys;
  return lane === 'organic' ? config.min_score : config.smart_lane_min_score;
}

export function convictionQueueStatus(ca: string, now = Date.now()): ConvictionQueueStatus {
  const slot = slots.find(candidate => candidate.ca === ca);
  if (!slot) {
    return {
      queued: false,
      lane: null,
      enteredAt: null,
      heldSeconds: 0,
      minimumHoldSeconds: 0,
      holdReady: false,
      scoreFloor: cfg().bestbuys.min_score,
    };
  }
  const heldSeconds = Math.max(0, (now - slot.enteredAt) / 1000);
  const minimum = minimumHoldSeconds(slot.lane);
  return {
    queued: true,
    lane: slot.lane,
    enteredAt: slot.enteredAt,
    heldSeconds,
    minimumHoldSeconds: minimum,
    holdReady: heldSeconds >= minimum,
    scoreFloor: scoreFloor(slot.lane),
  };
}

export function isConvictionCandidate(ca: string): boolean {
  return slots.some(slot => slot.ca === ca);
}

export function dropConvictionCandidate(ca: string, reason = 'removed'): boolean {
  const index = slots.findIndex(slot => slot.ca === ca);
  if (index < 0) return false;
  slots.splice(index, 1);
  if (reason !== 'alerted') droppedAt.set(ca, Date.now());
  console.log(`[conviction] removed ${ca.slice(0, 6)} — ${reason}`);
  return true;
}

function evidenceFloor(token: TokenRecord): boolean {
  const states = cfg().states;
  if (getStreamMode() === 'lite') return token.buys5m + token.sells5m >= states.trigger_min_trades;
  return token.totalBuys + token.totalSells >= states.trigger_min_trades
    && token.uniqueBuyers.length >= states.trigger_min_unique_buyers;
}

/**
 * A token can be high quality enough for the Convictions section without being a
 * safe entry at this exact second. The entry gate waits for the conviction to hold,
 * buyer flow to persist, and an extreme five-minute spike to cool before alerting.
 */
export function assessEntryTiming(
  token: TokenRecord,
  now = Date.now(),
  override?: ConvictionQueueStatus,
): EntryTimingAssessment {
  const states = cfg().states;
  const conviction = override || convictionQueueStatus(token.ca, now);
  const buyRatio = token.sells5m > 0 ? token.buys5m / token.sells5m : token.buys5m > 0 ? 3 : 1;
  const movedPct = token.firstScorePrice && token.priceUsd > 0
    ? (token.priceUsd / token.firstScorePrice - 1) * 100 : 0;
  const sourceEligible = recommendationEligibleSource(token.source);
  const modelAllows = decisionAllowsRecommendation(token, now);
  const evidenceReady = evidenceFloor(token);
  const persistenceReady = passesPersistence(token, now);
  const burstCooled = token.priceChange5m <= cfg().momentum.max_change5m_pct;
  const tooLate = !token.triggeredAt && movedPct >= states.extended_pct;
  const blockers: string[] = [];

  if (!conviction.queued) blockers.push('not selected for conviction');
  else if (!conviction.holdReady) {
    blockers.push(`conviction observation ${Math.ceil(conviction.minimumHoldSeconds - conviction.heldSeconds)}s remaining`);
  }
  if (!sourceEligible) blockers.push('source is research-only');
  if (!modelAllows) blockers.push('model enforcement abstained');
  if (token.score < conviction.scoreFloor) blockers.push(`score ${token.score.toFixed(1)} < ${conviction.scoreFloor}`);
  if (buyRatio < states.trigger_buy_ratio_min) blockers.push(`buy/sell ${buyRatio.toFixed(2)} < ${states.trigger_buy_ratio_min}`);
  if (!evidenceReady) blockers.push('not enough trade/buyer evidence');
  if (!persistenceReady) blockers.push('buyer persistence not confirmed');
  if (!burstCooled) blockers.push(`five-minute spike ${token.priceChange5m.toFixed(1)}% is too hot to chase`);
  if (tooLate) blockers.push(`already extended +${movedPct.toFixed(0)}%`);

  return {
    ready: blockers.length === 0,
    blockers,
    conviction,
    buyRatio,
    movedPct,
    evidenceReady,
    persistenceReady,
    burstCooled,
    tooLate,
    sourceEligible,
    modelAllows,
  };
}

async function admit(token: TokenRecord, lane: ConvictionLane, now: number) {
  if (slots.some(slot => slot.ca === token.ca)) return;
  slots.push({ ca: token.ca, enteredAt: now, peakScore: token.score, lane });
  if (!token.convictionAt) token.convictionAt = now;
  void upsertToken(token)
    .then(() => markConviction(token.ca, token.priceUsd))
    .catch(error => console.error('[conviction:persist]', (error as Error).message));
  if (token.priceUsd > 0) {
    void openPaper(token.ca, token.symbol, (`bb_${lane}`) as PaperSignal, token.priceUsd, token.score,
      token.modelDecision?.execution || undefined)
      .catch(error => console.error('[conviction:paper]', (error as Error).message));
  }
  console.log(`[conviction] queued $${token.symbol} lane=${lane} score=${token.score}`);
}

/** Refreshes the backend-owned conviction queue. It is called by the worker every
 * scoring cycle; dashboard traffic is not required for lifecycle progression. */
export function refreshConvictionQueue(now = Date.now()) {
  const config = cfg().bestbuys;
  const pruneBefore = now - config.reentry_cooldown_min * 60_000 * 2;
  for (const [ca, at] of droppedAt) if (at < pruneBefore) droppedAt.delete(ca);

  for (let index = slots.length - 1; index >= 0; index--) {
    const slot = slots[index];
    const token = getToken(slot.ca);
    let reason: string | null = null;
    if (!token) reason = 'token left the live store';
    else if (token.triggeredAt || token.state === 'TRIGGER') reason = 'alerted';
    else if (token.state === 'DEAD' || !decisionAllowsRecommendation(token)) reason = 'gone or model abstained';
    else {
      const rank = rankToken(token);
      slot.peakScore = Math.max(slot.peakScore, token.score);
      const retrace = token.gradPeak > 0 ? 1 - token.priceUsd / token.gradPeak : 0;
      if (token.bundle && token.bundle.fundedSnipers > 0) reason = 'insider detected';
      else if (token.insiderKilled) reason = 'insider detected';
      else if (token.state === 'DYING') reason = 'momentum died';
      else if (token.score < (slot.lane === 'smart' ? config.smart_lane_exit_score : config.exit_score)) reason = `score fell to ${token.score}`;
      else if (slot.lane === 'organic' && (rank.grade === 'C' || rank.grade === 'D')) reason = `degraded to ${rank.grade}`;
      else if (rank.timing === 'LATE' || rank.timing === 'STALE') reason = 'entry window closed';
      else if (slot.lane === 'smart' && smartCount(token, config) === 0) reason = 'smart wallets exited window';
      else if (slot.lane === 'pregrad' && token.dex !== 'pumpfun') reason = 'graduated before entry';
      else if (slot.lane === 'pregrad' && token.peakCurveSol > 34 && token.curveSol < token.peakCurveSol * 0.85) reason = 'curve reversed before graduation';
      else if (slot.lane === 'secondwave' && retrace > config.secondwave_max_retrace) reason = 'dumped through retrace floor';
      else if (slot.lane === 'secondwave' && token.priceUsd >= token.gradPeak * 1.5) reason = 'second wave already played out';
      else if (token.devBuyPct > config.max_dev_pct) reason = 'developer bag grew';
      else if (token.dex === 'pumpfun' && token.earlyBuyers.length >= 5
          && (1 - token.earlyExited.length / token.earlyBuyers.length) < config.min_retention) reason = 'early buyers dumping';
      else if (token.dex === 'pumpfun' && token.peakCurveSol > 34 && token.curveSol < token.peakCurveSol * 0.85) reason = 'curve outflow';
    }
    if (reason) {
      slots.splice(index, 1);
      if (reason !== 'alerted') droppedAt.set(slot.ca, now);
      console.log(`[conviction] removed ${slot.ca.slice(0, 6)} — ${reason}`);
    }
  }

  const inSlots = new Set(slots.map(slot => slot.ca));
  const cooldownMs = config.reentry_cooldown_min * 60_000;
  const eligible = (token: TokenRecord) => !inSlots.has(token.ca)
    && (droppedAt.get(token.ca) || 0) < now - cooldownMs;

  const organicSlots = () => slots.filter(slot => slot.lane === 'organic');
  const candidates = recommendationCandidates()
    .filter(eligible)
    .filter(token => (now - token.firstSeen) / 60_000 >= config.min_age_minutes)
    .map(token => ({ token, rank: rankToken(token) }))
    .filter(({ token, rank }) => ['A+', 'A', 'B'].includes(rank.grade)
      && ['EARLY', 'FAIR'].includes(rank.timing)
      && token.score >= config.min_score
      && Math.max(token.totalBuys + token.totalSells, token.buys5m + token.sells5m) >= config.min_trades
      && (token.uniqueBuyers.length >= config.min_unique_buyers || token.buys5m >= config.min_unique_buyers)
      && (token.dex !== 'pumpfun' || token.curveSol >= config.min_curve_sol)
      && token.devBuyPct <= config.max_dev_pct
      && hasIndependentOpportunityConfirmation(token, config)
      && (!config.require_social || hasSocial(token))
      && (!token.bundle || token.bundle.fundedSnipers === 0))
    .sort((left, right) => decisionStrength(right.token) - decisionStrength(left.token));

  for (const { token } of candidates) {
    if (organicSlots().length < config.max_shown) {
      void admit(token, 'organic', now);
      inSlots.add(token.ca);
    } else {
      const organic = organicSlots();
      const weakest = organic.reduce((minimum, slot) =>
        decisionStrength(getToken(slot.ca)!) < decisionStrength(getToken(minimum.ca)!) ? slot : minimum, organic[0]);
      const incumbent = getToken(weakest.ca);
      const heldSeconds = (now - weakest.enteredAt) / 1000;
      if (incumbent && heldSeconds >= config.min_hold_seconds
          && decisionStrength(token) > decisionStrength(incumbent) + 0.25) {
        droppedAt.set(weakest.ca, now);
        slots.splice(slots.indexOf(weakest), 1);
        inSlots.delete(weakest.ca);
        void admit(token, 'organic', now);
        inSlots.add(token.ca);
      }
    }
  }

  if (config.smart_lane && !slots.some(slot => slot.lane === 'smart')) {
    const smart = recommendationCandidates()
      .filter(eligible)
      .filter(token => !token.insiderKilled && !['DYING', 'DEAD', 'EXTENDED'].includes(token.state))
      .filter(token => (!token.bundle || token.bundle.fundedSnipers === 0) && token.devBuyPct <= config.max_dev_pct)
      .filter(token => (now - token.firstSeen) / 60_000 >= config.smart_lane_min_age_min
        && token.score >= config.smart_lane_min_score)
      .filter(token => !(token.dex === 'pumpfun' && token.peakCurveSol > 34 && token.curveSol < token.peakCurveSol * 0.9))
      .map(token => ({ token, count: smartCount(token, config) }))
      .filter(({ count }) => count >= config.smart_lane_min_wallets)
      .sort((left, right) => decisionStrength(right.token) - decisionStrength(left.token) || right.count - left.count);
    if (smart.length) void admit(smart[0].token, 'smart', now);
  }

  if (config.pregrad_lane && !slots.some(slot => slot.lane === 'pregrad')) {
    const near = recommendationCandidates()
      .filter(eligible)
      .filter(token => !token.insiderKilled && token.dex === 'pumpfun' && token.curveSol > 0)
      .filter(token => !['DYING', 'DEAD', 'EXTENDED'].includes(token.state)
        && (!token.bundle || token.bundle.fundedSnipers === 0)
        && token.devBuyPct <= config.max_dev_pct
        && token.score >= config.smart_lane_min_score
        && hasIndependentOpportunityConfirmation(token, config))
      .filter(token => token.curveSol >= GRADUATION_SOL * config.pregrad_min_pct && token.curveSol < GRADUATION_SOL)
      .map(token => {
        const reference = token.curveSamples.find(sample => now - sample.at >= 180_000);
        return { token, climbing: !reference || token.curveSol > reference.sol };
      })
      .filter(({ climbing }) => climbing)
      .sort((left, right) => decisionStrength(right.token) - decisionStrength(left.token));
    if (near.length) void admit(near[0].token, 'pregrad', now);
  }

  if (config.secondwave_lane && !slots.some(slot => slot.lane === 'secondwave')) {
    const wave = recommendationCandidates()
      .filter(eligible)
      .filter(token => !token.insiderKilled && !!token.gradAt && token.dex === 'pumpswap')
      .filter(token => now - (token.gradAt || 0) < config.secondwave_max_age_min * 60_000
        && (token.fillMinutes ?? 0) >= config.secondwave_min_fill_min
        && token.score >= config.smart_lane_min_score)
      .filter(token => isSecondWaveRetrace(token.priceUsd, token.gradPeak,
        config.secondwave_min_retrace, config.secondwave_max_retrace))
      .filter(token => !token.bundle || (token.bundle.clusterPct ?? token.bundle.insiderPct) <= config.max_cluster_pct)
      .filter(token => (token.deployerRep?.cls ?? 'KNOWN') !== 'SERIAL_DEAD'
        && smartCount(token, config) >= 1
        && !['DYING', 'DEAD', 'EXTENDED'].includes(token.state))
      .sort((left, right) => decisionStrength(right) - decisionStrength(left));
    if (wave.length) {
      wave[0].secondWaveAt = now;
      void admit(wave[0], 'secondwave', now);
    }
  }

  return serializeConvictions(now);
}

function serializeConvictions(now: number) {
  const config = cfg().bestbuys;
  return slots.slice().sort((left, right) => left.enteredAt - right.enteredAt).flatMap(slot => {
    const token = getToken(slot.ca);
    if (!token) return [];
    const rank = rankToken(token);
    const smart = smartStats(token, config);
    const model = token.modelDecision;
    const timing = assessEntryTiming(token, now);
    return [{
      ca: token.ca,
      symbol: token.symbol,
      grade: rank.grade,
      timing: rank.timing,
      lane: slot.lane,
      label: model
        ? `${rank.label} · v3 ${(model.targetBeforeStopProbability * 100).toFixed(1)}% target-before-loss · ${(model.cohortPercentile * 100).toFixed(0)}th percentile`
        : `${rank.label} · v3 evidence collecting`,
      confidence: rank.confidence,
      score: token.score,
      peakScore: slot.peakScore,
      heldMin: Math.round((now - slot.enteredAt) / 60_000),
      heldSeconds: Math.round((now - slot.enteredAt) / 1000),
      cautions: rank.cautions,
      waitingFor: timing.blockers,
      entryReady: timing.ready,
      liq: Math.round(token.liquidityUsd),
      buys: token.buys5m,
      sells: token.sells5m,
      smart: smart.wallets,
      smartElite: smart.elite,
      pair: token.pairAddress,
      model: model ? {
        version: model.modelVersion,
        targetBeforeStop: model.targetBeforeStopProbability,
        downside: model.downsideProbability,
        expectedValue: model.expectedValue,
        uncertainty: model.uncertainty,
        percentile: model.cohortPercentile,
        regime: model.regime.kind,
        execution: model.execution,
      } : null,
    }];
  });
}

export function currentConvictions(now = Date.now()) {
  return refreshConvictionQueue(now);
}

export const currentBestBuys = currentConvictions;
