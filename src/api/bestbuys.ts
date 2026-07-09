import { cfg } from '../config';
import { passesPersistence } from '../scoring/persistence';
import { activeTokens, getToken } from '../store';
import { rankToken } from '../scoring/rank';
import { TokenRecord } from '../types';
import { getStreamMode } from '../ingest/pumpfun';
import { weightedSmartHits } from '../wallets/tracker';

// STICKY BEST BUYS — a coin EARNS a slot (strict entry bar), then HOLDS it until
// it genuinely stops looking good (hysteresis: enter at min_score, exit only below
// exit_score, or on hard fails). Dropped coins can't flap back in for a cooldown.
// This makes the panel a stable shortlist you can actually watch, not a slot machine.


// tier-weighted smart-money confluence within the smart-lane window.
// Weight, not raw count, is the qualifying number: one ELITE wallet
// (elite_weight 3) clears a bar of 2 by itself — a 31-winner wallet's buy is
// worth more than two 2-winner wallets agreeing.
function smartCount(t: TokenRecord, bb: ReturnType<typeof cfg>['bestbuys']): number {
  return smartStats(t, bb).weight;
}
function smartStats(t: TokenRecord, bb: ReturnType<typeof cfg>['bestbuys']) {
  return weightedSmartHits(t.smartHits, bb.smart_lane_window_min * 60_000);
}

interface Slot { ca: string; enteredAt: number; peakScore: number; lane: 'organic' | 'smart' }
const slots: Slot[] = [];
const droppedAt = new Map<string, number>();   // ca -> when dropped (re-entry cooldown)

export function currentBestBuys() {
  const bb = cfg().bestbuys;
  const now = Date.now();

  // prune the re-entry cooldown map (bounded memory)
  const pruneBefore = now - bb.reentry_cooldown_min * 60_000 * 2;
  for (const [ca, at] of droppedAt) if (at < pruneBefore) droppedAt.delete(ca);

  // ---- 1. re-evaluate incumbents: hold unless genuinely degraded ----
  for (let i = slots.length - 1; i >= 0; i--) {
    const slot = slots[i];
    const t = getToken(slot.ca);
    const heldSec = (now - slot.enteredAt) / 1000;
    let dropReason: string | null = null;

    if (!t || t.state === 'DEAD') dropReason = 'gone';
    else {
      const r = rankToken(t);
      slot.peakScore = Math.max(slot.peakScore, t.score);
      // ALL quality fails drop IMMEDIATELY. The min-hold protects against slot
      // churn from supersession, never against showing a degraded coin — a D-grade
      // card in Best Buys is a lie regardless of how recently it was admitted.
      if (t.bundle && t.bundle.fundedSnipers > 0) dropReason = 'insider detected';
      else if (t.insiderKilled) dropReason = 'insider detected';
      else if (t.state === 'DYING') dropReason = 'momentum died';
      else if (t.score < (slot.lane === 'smart' ? bb.smart_lane_exit_score : bb.exit_score))
        dropReason = `score fell to ${t.score}`;
      else if (slot.lane === 'organic' && (r.grade === 'C' || r.grade === 'D')) dropReason = `degraded to ${r.grade}`;
      else if (slot.lane === 'organic' && (r.timing === 'LATE' || r.timing === 'STALE')) dropReason = 'entry window closed';
      else if (slot.lane === 'smart' && smartCount(t, bb) === 0) dropReason = 'smart wallets exited window';
      else if (t.devBuyPct > bb.max_dev_pct) dropReason = 'dev bag grew';
      else if (t.dex === 'pumpfun' && t.earlyBuyers.length >= 5
               && (1 - t.earlyExited.length / t.earlyBuyers.length) < bb.min_retention)
        dropReason = 'early buyers dumping';
      else if (t.dex === 'pumpfun' && t.peakCurveSol > 34 && t.curveSol < t.peakCurveSol * 0.85)
        dropReason = 'curve outflow';
      void heldSec;   // min_hold now only shields incumbents from supersession, below
    }
    if (dropReason) {
      droppedAt.set(slot.ca, now);
      slots.splice(i, 1);
    }
  }

  // ---- 2. admissions: strict entry bar, fill free slots, rare supersede ----
  const inSlots = new Set(slots.map(s => s.ca));
  const organicSlots = () => slots.filter(s => s.lane === 'organic');
  const cooldownMs = bb.reentry_cooldown_min * 60_000;
  const candidates = activeTokens()
    .filter(t => !inSlots.has(t.ca))
    .filter(t => (droppedAt.get(t.ca) || 0) < now - cooldownMs)
    .filter(t => passesPersistence(t, now))              // survived the snipe window
    .map(t => ({ t, r: rankToken(t) }))
    .filter(({ t, r }) =>
      ['A+', 'A'].includes(r.grade)
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
      // full: only supersede the weakest incumbent by a clear margin, and never
      // one still inside its minimum hold
      const org = organicSlots();
      const weakest = org.reduce((min, s) => {
        const st = getToken(s.ca);
        const mt = getToken(min.ca);
        return (st?.score ?? 0) < (mt?.score ?? 0) ? s : min;
      }, org[0]);
      const wt = getToken(weakest.ca);
      const heldSec = (now - weakest.enteredAt) / 1000;
      if (wt && heldSec >= bb.min_hold_seconds && t.score >= (wt.score + bb.supersede_margin)) {
        droppedAt.set(weakest.ca, now);
        slots.splice(slots.indexOf(weakest), 1);
        slots.push({ ca: t.ca, enteredAt: now, peakScore: t.score, lane: 'organic' });
      }
    }
  }

  // ---- 2b. SMART LANE: the wallet-sourced socket. When multiple wallets that
  // made money on OUR OWN logged winners converge on one fresh coin, that
  // confluence front-runs the score — retail volume (which the score needs)
  // hasn't arrived yet. Lower SCORE bar, identical SAFETY bar: gates passed,
  // no insider structure, dev bag capped. One socket, same hysteresis idea.
  if (bb.smart_lane && !slots.some(s => s.lane === 'smart')) {
    const smart = activeTokens()
      .filter(t => !inSlots.has(t.ca))
      .filter(t => (droppedAt.get(t.ca) || 0) < now - cooldownMs)
      .filter(t => t.gated === true && !t.insiderKilled)
      .filter(t => !['DYING', 'DEAD', 'EXTENDED'].includes(t.state))
      .filter(t => (!t.bundle || t.bundle.fundedSnipers === 0))
      .filter(t => t.devBuyPct <= bb.max_dev_pct)
      .filter(t => (now - t.firstSeen) / 60000 >= bb.smart_lane_min_age_min)
      .filter(t => t.score >= bb.smart_lane_min_score)
      // curve health without the full organic gauntlet: no meaningful drawdown
      .filter(t => !(t.dex === 'pumpfun' && t.peakCurveSol > 34 && t.curveSol < t.peakCurveSol * 0.9))
      .map(t => ({ t, n: smartCount(t, bb) }))
      .filter(({ n }) => n >= bb.smart_lane_min_wallets)
      .sort((a, b) => b.n - a.n || b.t.score - a.t.score);
    if (smart.length) {
      const { t } = smart[0];
      slots.push({ ca: t.ca, enteredAt: now, peakScore: t.score, lane: 'smart' });
    }
  }

  // ---- 3. serialize, stable order (longest-held first — rows don't jump) ----
  return slots
    .slice()
    .sort((a, b) => a.enteredAt - b.enteredAt)
    .map(s => {
      const t = getToken(s.ca)!;
      const r = rankToken(t);
      const st = smartStats(t, bb);
      return {
        ca: t.ca, symbol: t.symbol, grade: r.grade, timing: r.timing,
        lane: s.lane,
        label: s.lane === 'smart'
          ? `${st.elite ? st.elite + ' ELITE + ' : ''}${st.wallets - st.elite} proven-winner wallet${st.wallets !== 1 ? 's' : ''} bought this within ${bb.smart_lane_window_min}m (confluence weight ${st.weight}). ` + (r.label || '')
          : r.label,
        confidence: r.confidence, score: t.score, peakScore: s.peakScore,
        heldMin: Math.round((now - s.enteredAt) / 60000),
        cautions: r.cautions,
        liq: Math.round(t.liquidityUsd), buys: t.buys5m, sells: t.sells5m,
        smart: st.wallets,
        smartElite: st.elite,
        pair: t.pairAddress,
      };
    });
}
