import { gemini } from './gemini';
import { cfg, env } from '../config';

// AI SYSTEM MONITOR — "use the AI to understand what's happening behind the scenes."
// Distinct from the weekly report analysis (which tunes scoring): this reads the
// LIVE operational state — funnel counts, subsystem health, anomalies — and returns
// a plain-English health read: what's working, what's degraded, what's the single
// biggest problem right now. It's an on-demand ops diagnostic, not a tuning tool.
//
// It does NOT make changes. It observes and explains. The value is turning a wall
// of status numbers into "here's what's actually wrong and why" — the thing you'd
// otherwise have to reverse-engineer from the dashboard yourself.

export async function runSystemMonitor(snapshot: any): Promise<{ read: string | null; note?: string }> {
  if (!env.GEMINI_API_KEY) return { read: null, note: 'GEMINI_API_KEY not set' };

  const prompt = `You are the operations monitor for a live Solana memecoin scanner bot. Below is a real-time snapshot of its internal state. Give the operator a BLUNT, specific health read — not reassurance.

Structure your answer:
1. ONE-LINE STATUS: HEALTHY / DEGRADED / BROKEN + the single most important fact.
2. WHAT'S WRONG: the specific problems, worst first. Name the exact number that shows each one. If a subsystem is erroring or starved, say so and say what it blocks downstream.
3. WHAT'S FINE: briefly, what's working so they don't chase non-problems.
4. LIKELY CAUSE + FIX: for the biggest issue, your best guess at cause and the concrete fix (upgrade X, fund Y, the Z number is a bug, etc). If it's a data/infra bottleneck vs a code bug, say which.

Be concrete and quantitative. This is a trading system with real money — flag anything that silently loses signal. Do not invent numbers not in the snapshot. Keep it tight.

LIVE SNAPSHOT:
${JSON.stringify(snapshot, null, 2)}`;

  const read = await gemini(prompt, cfg().ai.review_model || 'gemini-3.5-flash', 2500);
  if (!read) return { read: null, note: 'Gemini call failed — check AI status' };
  return { read };
}
