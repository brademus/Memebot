import fs from 'fs';
import path from 'path';
import { cfg, env } from '../config';
import { gemini } from './gemini';
import { buildReport } from '../api/report';
import { latestSuggestion } from '../tuning/autotune';
import { pool } from '../db';

// AI REVIEWER — suggest-only, evidence-first tuning support.
// The daily master review includes aggregate calibration, cumulative profitability,
// runtime/data health, missed opportunities, and the complete recorded ledger for every
// paper call opened/closed during the daily window or still open.
export async function runAiReview(): Promise<{ review: string | null; basis: any }> {
  const basis = {
    report: await buildReport(1),
    autotuneSuggestion: latestSuggestion(),
    currentConfig: fs.readFileSync(path.join(process.cwd(), 'config.yaml'), 'utf8'),
  };
  if (!env.GEMINI_API_KEY) return { review: null, basis };

  const prompt = `You are the performance reviewer for a Solana memecoin scanner bot.
Below is (A) one complete daily master review containing the last 24 hours, cumulative results, runtime/data health, missed opportunities, and every relevant trade with its recorded entry rationale, execution, market path, exit timing, and exit reason; (B) the current config.yaml; and (C) the autotuner suggestion.

Write a tuning review with exactly these sections:
1. WORKING: what the evidence shows is working, citing numbers and specific trades when useful.
2. NOT WORKING: where calls, exits, data capture, lanes, gates, or execution are losing or failing.
3. CHANGES: specific config/code/research changes. Config edits must use "key: current -> proposed" and every change must cite evidence.
4. TRADE AUTOPSIES: the most instructive winning and losing calls, including why they entered, what happened after entry, when/why they closed, and what should be learned.
5. NOT ENOUGH DATA: conclusions that cannot yet be drawn and the exact sample/coverage needed.

Be blunt and numeric. Distinguish recorded facts from inference. Do not count tracking_lost rows as wins or losses. Do not claim live profitability from paper results. If evidence is insufficient, recommend gathering data rather than inventing a change. Keep the review under ~900 words.

(A) DAILY MASTER REVIEW: ${JSON.stringify(basis.report)}
(B) CONFIG: ${basis.currentConfig}
(C) AUTOTUNE: ${JSON.stringify(basis.autotuneSuggestion)}`;

  const review = await gemini(prompt, cfg().ai.review_model, 7000);
  if (review && pool) {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS ai_reviews (at TIMESTAMPTZ DEFAULT now(), review TEXT)`).catch(() => {});
    await pool.query(`INSERT INTO ai_reviews (review) VALUES ($1)`, [review]).catch(() => {});
  }
  return { review, basis: undefined };
}
