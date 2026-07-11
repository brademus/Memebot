import { cfg, env } from '../config';
import { gemini } from './gemini';
import { pool } from '../db';
import { TokenRecord } from '../types';

// AI NARRATIVE READ — judgment over the ONE thing the numeric score is blind to:
// the human-authored name / ticker / description. Is this riding a live narrative,
// or a low-effort clone / obvious scam wrapper? A number can't read that; a language
// model can. Runs ONCE per token at TRIGGER (bounded volume, not per-mint).
//
// SAFETY / MEASURABILITY — the whole point:
//   - The AI CANNOT create or block a trade. It returns a bounded nudge in
//     [-ai_max_delta, +ai_max_delta] applied to an ALREADY-triggered token's score.
//   - Every verdict is logged to Postgres with the token's eventual outcome
//     joinable — so the weekly report proves whether the AI read correlates with
//     winners. If it doesn't, set ai.conviction_enabled:false and it's gone.
//   - Fails neutral: no key, timeout, or parse failure = zero delta, no-op.
//
// This is AI as a MEASURED analyst, never an unaccountable oracle.

export async function aiConvictionRead(t: TokenRecord): Promise<void> {
  const c = cfg().ai;
  if (!c.enabled || !c.conviction_enabled || !env.GEMINI_API_KEY || t.aiConviction) return;

  const facts = {
    name: t.name, symbol: t.symbol,
    description: t.description || '(none provided)',
    hasX: t.socials.x, hasTelegram: t.socials.tg, tgMembers: t.socials.tgMembers,
    hasWebsite: t.socials.web,
    ageMinutes: Math.round((Date.now() - t.firstSeen) / 60000),
  };

  const prompt = `You judge Solana memecoin NARRATIVE quality — only what a number can't see. You are NOT scoring price/liquidity (already handled). Judge the NAME, TICKER, and DESCRIPTION.

Return STRICT JSON, nothing else:
{"verdict":"STRONG|NEUTRAL|WEAK","delta":<int -${cfg().ai.conviction_max_delta} to ${cfg().ai.conviction_max_delta}>,"reason":"<=12 words"}

STRONG (+): rides a live/timely narrative, coherent theme, effort evident, memetic legs.
NEUTRAL (0): generic but not bad.
WEAK (-): low-effort clone, empty/nonsense description, obvious scam wrapper, copied trending name to bait snipers.

Token: ${JSON.stringify(facts)}`;

  const raw = await gemini(prompt, c.conviction_model || c.note_model, 120);
  if (!raw) return;
  try {
    // Flash sometimes wraps JSON in prose ("Here is my analysis: {...}") or fences.
    // Extract the first {...} object rather than trusting the whole string parses.
    const match = raw.replace(/```json|```/g, '').match(/\{[\s\S]*\}/);
    if (!match) return;   // no JSON object present — fail neutral
    const j = JSON.parse(match[0]);
    const max = cfg().ai.conviction_max_delta;
    const delta = Math.max(-max, Math.min(max, Math.round(Number(j.delta) || 0)));
    t.aiConviction = {
      verdict: String(j.verdict || 'NEUTRAL').slice(0, 10),
      delta,
      reason: String(j.reason || '').slice(0, 100),
      at: Date.now(),
    };
    // scoreToken() applies the delta on every rebuild (score.ts) — no one-shot
    // mutation here, or it would double-count until the next rescore.
    if (pool) pool.query(
      `INSERT INTO ai_conviction (ca, symbol, verdict, delta, reason) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (ca) DO NOTHING`,
      [t.ca, t.symbol, t.aiConviction.verdict, delta, t.aiConviction.reason]).catch(() => {});
    console.log(`[ai] $${t.symbol} narrative ${t.aiConviction.verdict} ${delta >= 0 ? '+' : ''}${delta} — ${t.aiConviction.reason}`);
  } catch { /* non-JSON: fail neutral */ }
}
