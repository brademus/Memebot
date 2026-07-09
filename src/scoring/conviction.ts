import { cfg } from '../config';
import { TokenRecord } from './../types';
import { passesPersistence } from './persistence';
import { weightedSmartHits } from '../wallets/tracker';

// CONVICTION TIER — the "confirmed buy" layer above TRIGGER.
//
// Rationale: TRIGGER is a momentum+persistence signal and fires dozens of times a
// day; its precision ceiling is structural. The report data says the real edge is
// in CONFIRMATION: insider-verified-clean tokens averaged 2.69x vs 0.88x unknown,
// and smart-wallet confluence is the only signal sourced from wallets with a
// proven win record. CONVICTION only fires when independent signals AGREE:
//
//   1. TRIGGER held for N seconds without demotion  (survived the sniper-exit window)
//   2. Bundle check VERIFIED clean — not merely unverified (null ≠ clean)
//   3. ≥N distinct tracked smart wallets bought recently
//   4. Social presence live (17.4x graduation differential)
//   5. Price hasn't already run past max_run_pct (no late entries)
//   6. Persistence gauntlet still passing at confirmation time
//
// Expected volume: a handful per day, sometimes zero. Zero is a valid output —
// the tier's job is precision, and conviction_at in Postgres lets the weekly
// review MEASURE that precision against the trigger cohort.

export interface ConvictionResult {
  pass: boolean;
  confirmed: string[];   // human-readable evidence, used in the alert body
  missing: string[];     // what blocked it, visible on the dashboard for tuning
}

// daily alert budget — scarcity is the product
let dayKey = '';
let firedToday = 0;
function budgetLeft(max: number): boolean {
  const k = new Date().toISOString().slice(0, 10);
  if (k !== dayKey) { dayKey = k; firedToday = 0; }
  return firedToday < max;
}
export function consumeBudget() { firedToday++; }
export const convictionFiredToday = () => firedToday;

export function checkConviction(t: TokenRecord, now = Date.now()): ConvictionResult {
  const c = cfg().conviction;
  const b = cfg().bundle;
  const confirmed: string[] = [];
  const missing: string[] = [];
  if (!c || !c.enabled) return { pass: false, confirmed, missing: ['conviction disabled'] };

  // 0. base: must currently be a live TRIGGER at conviction-grade score
  if (t.state !== 'TRIGGER') missing.push('not in TRIGGER');
  if (t.score < c.min_score) missing.push(`score ${t.score} < ${c.min_score}`);
  else confirmed.push(`score ${t.score}`);

  // 1. held TRIGGER through the burst window
  const heldSec = (now - t.stateChangedAt) / 1000;
  if (t.state === 'TRIGGER' && heldSec >= c.min_trigger_hold_seconds)
    confirmed.push(`held TRIGGER ${Math.round(heldSec)}s`);
  else missing.push(`trigger hold ${Math.round(heldSec)}s < ${c.min_trigger_hold_seconds}s`);

  // 2. insider check VERIFIED clean — the 2.69x vs 0.88x signal.
  //    t.bundle === null means Helius never confirmed anything; that is NOT clean.
  if (c.require_clean_bundle) {
    if (t.insiderKilled) missing.push('insider-killed');
    else if (t.bundle === null) missing.push('bundle unverified');
    else if (t.bundle.fundedSnipers > 0) missing.push(`${t.bundle.fundedSnipers} funded snipers`);
    else if (t.bundle.insiderPct > b.max_insider_supply_pct) missing.push(`insider ${t.bundle.insiderPct.toFixed(0)}%`);
    else confirmed.push(`insiders verified clean (0 funded snipers, slot0 ${t.bundle.insiderPct.toFixed(0)}%)`);
  }

  // 3. smart-wallet confluence — tier-weighted: one ELITE wallet outweighs
  // several marginal ones, so it clears this check alone
  const winMs = c.smart_wallet_window_min * 60_000;
  const sh = weightedSmartHits(t.smartHits, winMs, now);
  if (sh.weight >= c.min_smart_wallets)
    confirmed.push(sh.elite
      ? `${sh.elite} ELITE wallet${sh.elite > 1 ? 's' : ''} bought (weight ${sh.weight}, last ${c.smart_wallet_window_min}m)`
      : `${sh.wallets} smart wallet${sh.wallets > 1 ? 's' : ''} bought (last ${c.smart_wallet_window_min}m)`);
  else missing.push(`smart weight ${sh.weight}/${c.min_smart_wallets}`);

  // 4. social presence
  if (c.require_social) {
    if (t.socials.tg || t.socials.x)
      confirmed.push(`socials live (${[t.socials.tg && 'TG', t.socials.x && 'X', t.socials.web && 'web'].filter(Boolean).join('+')})`);
    else missing.push('no TG/X');
  }

  // 5. entry still fresh — don't confirm someone into exit liquidity
  if (t.firstScorePrice && t.priceUsd > 0) {
    const ran = ((t.priceUsd / t.firstScorePrice) - 1) * 100;
    if (ran <= c.max_run_pct) confirmed.push(`moved only ${ran.toFixed(0)}% since first score`);
    else missing.push(`already ran ${ran.toFixed(0)}% > ${c.max_run_pct}%`);
  }

  // 6. persistence re-verified at confirmation time
  if (passesPersistence(t, now)) {
    if (t.earlyBuyers.length >= 5)
      confirmed.push(`early-buyer retention ${((1 - t.earlyExited.length / t.earlyBuyers.length) * 100).toFixed(0)}%`);
  } else missing.push('persistence failed at confirm time');

  // 7. daily budget
  if (!budgetLeft(c.max_alerts_per_day)) missing.push('daily alert budget spent');

  return { pass: missing.length === 0, confirmed, missing };
}
