import { cfg } from '../config';
import { passesPersistence } from '../scoring/persistence';
import { activeTokens, getToken } from '../store';
import { rankToken } from '../scoring/rank';
import { TokenRecord } from '../types';
import { weightedSmartHits } from '../wallets/tracker';
import { GRADUATION_SOL } from '../constants';
import { openPaper, PaperSignal } from '../paper/paper';
import { recommendationEligibleSource } from '../model/version';

function smartStats(t: TokenRecord, bb: ReturnType<typeof cfg>['bestbuys']) {
  return weightedSmartHits(t.smartHits, bb.smart_lane_window_min * 60_000);
}
function smartCount(t: TokenRecord, bb: ReturnType<typeof cfg>['bestbuys']): number {
  return smartStats(t, bb).weight;
}
export function isSecondWaveRetrace(price: number, peak: number, minRetrace: number, maxRetrace: number): boolean {
  if (!(price > 0) || !(peak > 0)) return false;
  const retrace = 1 - price / peak;
  return retrace >= minRetrace && retrace <= maxRetrace;
}

interface Slot { ca: string; enteredAt: number; peakScore: number; lane: 'organic' | 'smart' | 'pregrad' | 'secondwave' }
const slots: Slot[] = [];
const droppedAt = new Map<string, number>();

const recommendationCandidates = () => activeTokens().filter(token => recommendationEligibleSource(token.source));

export function currentBestBuys() {
  const bb = cfg().bestbuys;
  const now = Date.now();
  const pruneBefore = now - bb.reentry_cooldown_min * 60_000 * 2;
  for (const [ca, at] of droppedAt) if (at < pruneBefore) droppedAt.delete(ca);

  for (let index = slots.length - 1; index >= 0; index--) {
    const slot = slots[index];
    const token = getToken(slot.ca);
    let dropReason: string | null = null;
    if (!token || token.state === 'DEAD' || !recommendationEligibleSource(token.source)) dropReason = 'gone or quarantined';
    else {
      const rank = rankToken(token);
      slot.peakScore = Math.max(slot.peakScore, token.score);
      const retrace = token.gradPeak > 0 ? 1 - token.priceUsd / token.gradPeak : 0;
      if (token.bundle && token.bundle.fundedSnipers > 0) dropReason = 'insider detected';
      else if (token.insiderKilled) dropReason = 'insider detected';
      else if (token.state === 'DYING') dropReason = 'momentum died';
      else if (token.score < (slot.lane === 'smart' ? bb.smart_lane_exit_score : bb.exit_score)) dropReason = `score fell to ${token.score}`;
      else if (slot.lane === 'organic' && (rank.grade === 'C' || rank.grade === 'D')) dropReason = `degraded to ${rank.grade}`;
      else if (slot.lane === 'organic' && (rank.timing === 'LATE' || rank.timing === 'STALE')) dropReason = 'entry window closed';
      else if (slot.lane === 'smart' && smartCount(token, bb) === 0) dropReason = 'smart wallets exited window';
      else if (slot.lane === 'pregrad' && token.dex !== 'pumpfun') dropReason = 'graduated — catalyst played out';
      else if (slot.lane === 'pregrad' && token.peakCurveSol > 34 && token.curveSol < token.peakCurveSol * 0.85) dropReason = 'curve reversed before graduation';
      else if (slot.lane === 'secondwave' && retrace > bb.secondwave_max_retrace) dropReason = 'dumped through configured retrace floor';
      else if (slot.lane === 'secondwave' && token.priceUsd >= token.gradPeak * 1.5) dropReason = 'recovered 1.5x — second wave played out';
      else if (token.devBuyPct > bb.max_dev_pct) dropReason = 'dev bag grew';
      else if (token.dex === 'pumpfun' && token.earlyBuyers.length >= 5 && (1 - token.earlyExited.length / token.earlyBuyers.length) < bb.min_retention) dropReason = 'early buyers dumping';
      else if (token.dex === 'pumpfun' && token.peakCurveSol > 34 && token.curveSol < token.peakCurveSol * 0.85) dropReason = 'curve outflow';
    }
    if (dropReason) {
      droppedAt.set(slot.ca, now);
      slots.splice(index, 1);
    }
  }

  const inSlots = new Set(slots.map(slot => slot.ca));
  const organicSlots = () => slots.filter(slot => slot.lane === 'organic');
  const cooldownMs = bb.reentry_cooldown_min * 60_000;
  const candidates = recommendationCandidates()
    .filter(token => !inSlots.has(token.ca))
    .filter(token => (droppedAt.get(token.ca) || 0) < now - cooldownMs)
    .filter(token => passesPersistence(token, now))
    .map(token => ({ token, rank: rankToken(token) }))
    .filter(({ token, rank }) => ['A+', 'A'].includes(rank.grade)
      && rank.timing === 'EARLY'
      && token.score >= bb.min_score
      && (token.totalBuys + token.totalSells) >= bb.min_trades
      && token.uniqueBuyers.length >= bb.min_unique_buyers
      && token.curveSol >= bb.min_curve_sol
      && token.devBuyPct <= bb.max_dev_pct
      && (!bb.require_social || token.socials.tg || token.socials.x)
      && (!token.bundle || token.bundle.fundedSnipers === 0))
    .sort((a, b) => b.token.score - a.token.score);

  for (const { token } of candidates) {
    if (organicSlots().length < bb.max_shown) {
      slots.push({ ca: token.ca, enteredAt: now, peakScore: token.score, lane: 'organic' });
    } else {
      const organic = organicSlots();
      const weakest = organic.reduce((minimum, slot) => (getToken(slot.ca)?.score ?? 0) < (getToken(minimum.ca)?.score ?? 0) ? slot : minimum, organic[0]);
      const incumbent = getToken(weakest.ca);
      const heldSeconds = (now - weakest.enteredAt) / 1000;
      if (incumbent && heldSeconds >= bb.min_hold_seconds && token.score >= incumbent.score + bb.supersede_margin) {
        droppedAt.set(weakest.ca, now);
        slots.splice(slots.indexOf(weakest), 1);
        slots.push({ ca: token.ca, enteredAt: now, peakScore: token.score, lane: 'organic' });
      }
    }
  }

  if (bb.smart_lane && !slots.some(slot => slot.lane === 'smart')) {
    const smart = recommendationCandidates()
      .filter(token => !inSlots.has(token.ca) && (droppedAt.get(token.ca) || 0) < now - cooldownMs)
      .filter(token => token.gated === true && !token.insiderKilled && !['DYING', 'DEAD', 'EXTENDED'].includes(token.state))
      .filter(token => (!token.bundle || token.bundle.fundedSnipers === 0) && token.devBuyPct <= bb.max_dev_pct)
      .filter(token => (now - token.firstSeen) / 60_000 >= bb.smart_lane_min_age_min && token.score >= bb.smart_lane_min_score)
      .filter(token => !(token.dex === 'pumpfun' && token.peakCurveSol > 34 && token.curveSol < token.peakCurveSol * 0.9))
      .map(token => ({ token, count: smartCount(token, bb) }))
      .filter(({ count }) => count >= bb.smart_lane_min_wallets)
      .sort((a, b) => b.count - a.count || b.token.score - a.token.score);
    if (smart.length) slots.push({ ca: smart[0].token.ca, enteredAt: now, peakScore: smart[0].token.score, lane: 'smart' });
  }

  if (bb.pregrad_lane && !slots.some(slot => slot.lane === 'pregrad')) {
    const near = recommendationCandidates()
      .filter(token => !inSlots.has(token.ca) && (droppedAt.get(token.ca) || 0) < now - cooldownMs)
      .filter(token => token.gated === true && !token.insiderKilled && token.dex === 'pumpfun' && token.curveSol > 0)
      .filter(token => !['DYING', 'DEAD'].includes(token.state) && (!token.bundle || token.bundle.fundedSnipers === 0) && token.devBuyPct <= bb.max_dev_pct)
      .filter(token => token.curveSol >= GRADUATION_SOL * bb.pregrad_min_pct && token.curveSol < GRADUATION_SOL)
      .map(token => {
        const reference = token.curveSamples.find(sample => now - sample.at >= 3 * 60_000);
        return { token, climbing: !reference || token.curveSol > reference.sol, pct: Math.round(token.curveSol / GRADUATION_SOL * 100) };
      })
      .filter(({ climbing }) => climbing)
      .sort((a, b) => b.pct - a.pct);
    if (near.length) slots.push({ ca: near[0].token.ca, enteredAt: now, peakScore: near[0].token.score, lane: 'pregrad' });
  }

  if (bb.secondwave_lane && !slots.some(slot => slot.lane === 'secondwave')) {
    const secondWave = recommendationCandidates()
      .filter(token => !inSlots.has(token.ca) && (droppedAt.get(token.ca) || 0) < now - cooldownMs)
      .filter(token => token.gated === true && !token.insiderKilled && !!token.gradAt && token.dex === 'pumpswap')
      .filter(token => now - (token.gradAt || 0) < bb.secondwave_max_age_min * 60_000)
      .filter(token => (token.fillMinutes ?? 0) >= bb.secondwave_min_fill_min)
      .filter(token => isSecondWaveRetrace(token.priceUsd, token.gradPeak, bb.secondwave_min_retrace, bb.secondwave_max_retrace))
      .filter(token => !token.bundle || ((token.bundle.clusterPct ?? token.bundle.insiderPct) <= bb.max_cluster_pct))
      .filter(token => (token.deployerRep?.cls ?? 'KNOWN') !== 'SERIAL_DEAD')
      .filter(token => smartCount(token, bb) >= 1 && !['DYING', 'DEAD'].includes(token.state))
      .map(token => ({ token, retrace: 1 - token.priceUsd / token.gradPeak }))
      .sort((a, b) => b.retrace - a.retrace);
    if (secondWave.length) {
      const token = secondWave[0].token;
      token.secondWaveAt = now;
      slots.push({ ca: token.ca, enteredAt: now, peakScore: token.score, lane: 'secondwave' });
    }
  }

  for (const slot of slots) {
    if (slot.enteredAt === now) {
      const token = getToken(slot.ca);
      if (token && token.priceUsd > 0) openPaper(token.ca, token.symbol, (`bb_${slot.lane}`) as PaperSignal, token.priceUsd, token.score);
    }
  }

  return slots.slice().sort((a, b) => a.enteredAt - b.enteredAt).map(slot => {
    const token = getToken(slot.ca)!;
    const rank = rankToken(token);
    const smart = smartStats(token, bb);
    return {
      ca: token.ca, symbol: token.symbol, grade: rank.grade, timing: rank.timing, lane: slot.lane,
      label: slot.lane === 'smart'
        ? `${smart.elite ? smart.elite + ' ELITE + ' : ''}${smart.wallets - smart.elite} proven-winner wallet${smart.wallets !== 1 ? 's' : ''} bought this within ${bb.smart_lane_window_min}m (confluence weight ${smart.weight}). ${rank.label || ''}`
        : slot.lane === 'pregrad'
        ? `${Math.round(token.curveSol / GRADUATION_SOL * 100)}% to graduation with active inflow — catch the run in, not the retrace after. ${rank.label || ''}`
        : slot.lane === 'secondwave'
        ? `post-graduation retrace ${Math.round((1 - token.priceUsd / token.gradPeak) * 100)}% off peak · ${token.fillMinutes}m fill · clean structure — second-wave entry, not the top. ${rank.label || ''}`
        : rank.label,
      confidence: rank.confidence, score: token.score, peakScore: slot.peakScore,
      heldMin: Math.round((now - slot.enteredAt) / 60_000), cautions: rank.cautions,
      liq: Math.round(token.liquidityUsd), buys: token.buys5m, sells: token.sells5m,
      smart: smart.wallets, smartElite: smart.elite, pair: token.pairAddress,
    };
  });
}
