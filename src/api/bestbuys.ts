import { cfg } from '../config';
import { activeTokens, getToken } from '../store';
import { rankToken } from '../scoring/rank';
import { TokenRecord } from '../types';
import { getStreamMode } from '../ingest/pumpfun';

// STICKY BEST BUYS — a coin EARNS a slot (strict entry bar), then HOLDS it until
// it genuinely stops looking good (hysteresis: enter at min_score, exit only below
// exit_score, or on hard fails). Dropped coins can't flap back in for a cooldown.
// This makes the panel a stable shortlist you can actually watch, not a slot machine.

interface Slot { ca: string; enteredAt: number; peakScore: number }
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
      // hard fails: drop immediately regardless of hold time
      if (t.bundle && t.bundle.fundedSnipers > 0) dropReason = 'insider detected';
      else if (t.state === 'DYING') dropReason = 'momentum died';
      else if (heldSec >= bb.min_hold_seconds) {
        // soft fails: only after minimum hold
        if (t.score < bb.exit_score) dropReason = `score fell to ${t.score}`;
        else if (r.timing === 'LATE' || r.timing === 'STALE') dropReason = 'entry window closed';
        else if (t.devBuyPct > bb.max_dev_pct) dropReason = 'dev bag grew';
      }
    }
    if (dropReason) {
      droppedAt.set(slot.ca, now);
      slots.splice(i, 1);
    }
  }

  // ---- 2. admissions: strict entry bar, fill free slots, rare supersede ----
  const inSlots = new Set(slots.map(s => s.ca));
  const cooldownMs = bb.reentry_cooldown_min * 60_000;
  const candidates = activeTokens()
    .filter(t => !inSlots.has(t.ca))
    .filter(t => (droppedAt.get(t.ca) || 0) < now - cooldownMs)
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
    if (slots.length < bb.max_shown) {
      slots.push({ ca: t.ca, enteredAt: now, peakScore: t.score });
    } else {
      // full: only supersede the weakest incumbent by a clear margin, and never
      // one still inside its minimum hold
      const weakest = slots.reduce((min, s) => {
        const st = getToken(s.ca);
        const mt = getToken(min.ca);
        return (st?.score ?? 0) < (mt?.score ?? 0) ? s : min;
      }, slots[0]);
      const wt = getToken(weakest.ca);
      const heldSec = (now - weakest.enteredAt) / 1000;
      if (wt && heldSec >= bb.min_hold_seconds && t.score >= (wt.score + bb.supersede_margin)) {
        droppedAt.set(weakest.ca, now);
        slots.splice(slots.indexOf(weakest), 1);
        slots.push({ ca: t.ca, enteredAt: now, peakScore: t.score });
      }
    }
  }

  // ---- 3. serialize, stable order (longest-held first — rows don't jump) ----
  return slots
    .slice()
    .sort((a, b) => a.enteredAt - b.enteredAt)
    .map(s => {
      const t = getToken(s.ca)!;
      const r = rankToken(t);
      return {
        ca: t.ca, symbol: t.symbol, grade: r.grade, label: r.label, timing: r.timing,
        confidence: r.confidence, score: t.score, peakScore: s.peakScore,
        heldMin: Math.round((now - s.enteredAt) / 60000),
        cautions: r.cautions,
        liq: Math.round(t.liquidityUsd), buys: t.buys5m, sells: t.sells5m,
        smart: new Set(t.smartHits.map(h => h.wallet)).size,
        pair: t.pairAddress,
      };
    });
}
