import { cfg } from '../config';
import { passesPersistence } from '../scoring/persistence';
import { activeTokens, getToken } from '../store';
import { rankToken } from '../scoring/rank';
import { TokenRecord } from '../types';
import { weightedSmartHits } from '../wallets/tracker';
import { GRADUATION_SOL } from '../constants';
import { openPaper, PaperSignal } from '../paper/paper';

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

export function currentBestBuys() {
  const bb = cfg().bestbuys;
  const now = Date.now();
  const pruneBefore = now - bb.reentry_cooldown_min * 60_000 * 2;
  for (const [ca, at] of droppedAt) if (at < pruneBefore) droppedAt.delete(ca);

  for (let i = slots.length - 1; i >= 0; i--) {
    const slot = slots[i];
    const t = getToken(slot.ca);
    let dropReason: string | null = null;
    if (!t || t.state === 'DEAD') dropReason = 'gone';
    else {
      const r = rankToken(t);
      slot.peakScore = Math.max(slot.peakScore, t.score);
      const retrace = t.gradPeak > 0 ? 1 - t.priceUsd / t.gradPeak : 0;
      if (t.bundle && t.bundle.fundedSnipers > 0) dropReason = 'insider detected';
      else if (t.insiderKilled) dropReason = 'insider detected';
      else if (t.state === 'DYING') dropReason = 'momentum died';
      else if (t.score < (slot.lane === 'smart' ? bb.smart_lane_exit_score : bb.exit_score)) dropReason = `score fell to ${t.score}`;
      else if (slot.lane === 'organic' && (r.grade === 'C' || r.grade === 'D')) dropReason = `degraded to ${r.grade}`;
      else if (slot.lane === 'organic' && (r.timing === 'LATE' || r.timing === 'STALE')) dropReason = 'entry window closed';
      else if (slot.lane === 'smart' && smartCount(t, bb) === 0) dropReason = 'smart wallets exited window';
      else if (slot.lane === 'pregrad' && t.dex !== 'pumpfun') dropReason = 'graduated — catalyst played out';
      else if (slot.lane === 'pregrad' && t.peakCurveSol > 34 && t.curveSol < t.peakCurveSol * 0.85) dropReason = 'curve reversed before graduation';
      else if (slot.lane === 'secondwave' && retrace > bb.secondwave_max_retrace) dropReason = 'dumped through configured retrace floor';
      else if (slot.lane === 'secondwave' && t.priceUsd >= t.gradPeak * 1.5) dropReason = 'recovered 1.5x — second wave played out';
      else if (t.devBuyPct > bb.max_dev_pct) dropReason = 'dev bag grew';
      else if (t.dex === 'pumpfun' && t.earlyBuyers.length >= 5 && (1 - t.earlyExited.length / t.earlyBuyers.length) < bb.min_retention) dropReason = 'early buyers dumping';
      else if (t.dex === 'pumpfun' && t.peakCurveSol > 34 && t.curveSol < t.peakCurveSol * 0.85) dropReason = 'curve outflow';
    }
    if (dropReason) {
      droppedAt.set(slot.ca, now);
      slots.splice(i, 1);
    }
  }

  const inSlots = new Set(slots.map(s => s.ca));
  const organicSlots = () => slots.filter(s => s.lane === 'organic');
  const cooldownMs = bb.reentry_cooldown_min * 60_000;
  const candidates = activeTokens()
    .filter(t => !inSlots.has(t.ca))
    .filter(t => (droppedAt.get(t.ca) || 0) < now - cooldownMs)
    .filter(t => passesPersistence(t, now))
    .map(t => ({ t, r: rankToken(t) }))
    .filter(({ t, r }) => ['A+', 'A'].includes(r.grade)
      && r.timing === 'EARLY'
      && t.score >= bb.min_score
      && (t.totalBuys + t.totalSells) >= bb.min_trades
      && t.uniqueBuyers.length >= bb.min_unique_buyers
      && t.curveSol >= bb.min_curve_sol
      && t.devBuyPct <= bb.max_dev_pct
      && (!bb.require_social || t.socials.tg || t.socials.x)
      && (!t.bundle || t.bundle.fundedSnipers === 0))
    .sort((a, b) => b.t.score - a.t.score);

  for (const { t } of candidates) {
    if (organicSlots().length < bb.max_shown) {
      slots.push({ ca: t.ca, enteredAt: now, peakScore: t.score, lane: 'organic' });
    } else {
      const org = organicSlots();
      const weakest = org.reduce((min, s) => (getToken(s.ca)?.score ?? 0) < (getToken(min.ca)?.score ?? 0) ? s : min, org[0]);
      const incumbent = getToken(weakest.ca);
      const heldSec = (now - weakest.enteredAt) / 1000;
      if (incumbent && heldSec >= bb.min_hold_seconds && t.score >= incumbent.score + bb.supersede_margin) {
        droppedAt.set(weakest.ca, now);
        slots.splice(slots.indexOf(weakest), 1);
        slots.push({ ca: t.ca, enteredAt: now, peakScore: t.score, lane: 'organic' });
      }
    }
  }

  if (bb.smart_lane && !slots.some(s => s.lane === 'smart')) {
    const smart = activeTokens()
      .filter(t => !inSlots.has(t.ca) && (droppedAt.get(t.ca) || 0) < now - cooldownMs)
      .filter(t => t.gated === true && !t.insiderKilled && !['DYING', 'DEAD', 'EXTENDED'].includes(t.state))
      .filter(t => (!t.bundle || t.bundle.fundedSnipers === 0) && t.devBuyPct <= bb.max_dev_pct)
      .filter(t => (now - t.firstSeen) / 60000 >= bb.smart_lane_min_age_min && t.score >= bb.smart_lane_min_score)
      .filter(t => !(t.dex === 'pumpfun' && t.peakCurveSol > 34 && t.curveSol < t.peakCurveSol * 0.9))
      .map(t => ({ t, n: smartCount(t, bb) }))
      .filter(({ n }) => n >= bb.smart_lane_min_wallets)
      .sort((a, b) => b.n - a.n || b.t.score - a.t.score);
    if (smart.length) slots.push({ ca: smart[0].t.ca, enteredAt: now, peakScore: smart[0].t.score, lane: 'smart' });
  }

  if (bb.pregrad_lane && !slots.some(s => s.lane === 'pregrad')) {
    const near = activeTokens()
      .filter(t => !inSlots.has(t.ca) && (droppedAt.get(t.ca) || 0) < now - cooldownMs)
      .filter(t => t.gated === true && !t.insiderKilled && t.dex === 'pumpfun' && t.curveSol > 0)
      .filter(t => !['DYING', 'DEAD'].includes(t.state) && (!t.bundle || t.bundle.fundedSnipers === 0) && t.devBuyPct <= bb.max_dev_pct)
      .filter(t => t.curveSol >= GRADUATION_SOL * bb.pregrad_min_pct && t.curveSol < GRADUATION_SOL)
      .map(t => {
        const ref = t.curveSamples.find(sample => now - sample.at >= 3 * 60_000);
        return { t, climbing: !ref || t.curveSol > ref.sol, pct: Math.round(t.curveSol / GRADUATION_SOL * 100) };
      })
      .filter(({ climbing }) => climbing)
      .sort((a, b) => b.pct - a.pct);
    if (near.length) slots.push({ ca: near[0].t.ca, enteredAt: now, peakScore: near[0].t.score, lane: 'pregrad' });
  }

  if (bb.secondwave_lane && !slots.some(s => s.lane === 'secondwave')) {
    const candidates2 = activeTokens()
      .filter(t => !inSlots.has(t.ca) && (droppedAt.get(t.ca) || 0) < now - cooldownMs)
      .filter(t => t.gated === true && !t.insiderKilled && !!t.gradAt && t.dex === 'pumpswap')
      .filter(t => now - (t.gradAt || 0) < bb.secondwave_max_age_min * 60_000)
      .filter(t => (t.fillMinutes ?? 0) >= bb.secondwave_min_fill_min)
      .filter(t => isSecondWaveRetrace(t.priceUsd, t.gradPeak, bb.secondwave_min_retrace, bb.secondwave_max_retrace))
      .filter(t => !t.bundle || ((t.bundle.clusterPct ?? t.bundle.insiderPct) <= bb.max_cluster_pct))
      .filter(t => (t.deployerRep?.cls ?? 'KNOWN') !== 'SERIAL_DEAD')
      .filter(t => smartCount(t, bb) >= 1 && !['DYING', 'DEAD'].includes(t.state))
      .map(t => ({ t, retrace: 1 - t.priceUsd / t.gradPeak }))
      .sort((a, b) => b.retrace - a.retrace);
    if (candidates2.length) {
      const token = candidates2[0].t;
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
      heldMin: Math.round((now - slot.enteredAt) / 60000), cautions: rank.cautions,
      liq: Math.round(token.liquidityUsd), buys: token.buys5m, sells: token.sells5m,
      smart: smart.wallets, smartElite: smart.elite, pair: token.pairAddress,
    };
  });
}
