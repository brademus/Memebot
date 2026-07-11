import fs from 'fs';
import path from 'path';
import { cfg, env } from '../config';
import { gemini } from './gemini';
import { buildReport } from '../api/report';
import { latestSuggestion } from '../tuning/autotune';
import { pool } from '../db';

// AI REVIEWER — the "analyze everything and make it better" loop, done honestly.
// Pro-tier Gemini reads: (1) full performance report (trigger outcomes, score
// calibration, false kills, insider correlation), (2) the live config, (3) the
// autotune statistical suggestion — and writes a tuning review with specific
// config.yaml changes and its reasoning.
//
// SUGGEST-ONLY BY DESIGN: it never edits config itself. The human reads the
// review and applies changes. An AI silently rewriting the scoring of a money
// bot is how systems quietly break — the review is the product, not the edit.
export async function runAiReview(): Promise<{ review: string | null; basis: any }> {
  const basis = {
    report: await buildReport(),
    autotuneSuggestion: latestSuggestion(),
    currentConfig: fs.readFileSync(path.join(process.cwd(), 'config.yaml'), 'utf8'),
  };
  if (!env.GEMINI_API_KEY) return { review: null, basis };

  const prompt = `You are the performance reviewer for a Solana memecoin scanner bot.
Below is (A) its outcome report, (B) its current config.yaml, (C) a statistical weight suggestion from its autotuner.

Write a tuning review with exactly these sections:
1. WORKING: what the data shows is working (cite the numbers).
2. NOT WORKING: where the algorithm is losing (false kills, miscalibrated score bands, bad thresholds — cite numbers).
3. CHANGES: specific config.yaml edits, as "key: current -> proposed", each with one line of reasoning grounded in the data. If autotune's weights disagree with your read, say which to trust and why.
4. NOT ENOUGH DATA: which conclusions can't be drawn yet and what sample size is needed.
Be blunt and numeric. SYNTHESIZE — do not recite every tercile/row from the report back to me; cite only the specific numbers that justify a conclusion. If the dataset is too small for any confident change, say so plainly and recommend waiting — do not invent changes to seem useful. Keep the whole review under ~500 words.

(A) REPORT: ${JSON.stringify(basis.report)}
(B) CONFIG: ${basis.currentConfig}
(C) AUTOTUNE: ${JSON.stringify(basis.autotuneSuggestion)}`;

  const review = await gemini(prompt, cfg().ai.review_model, 4000);
  if (review && pool) {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS ai_reviews (at TIMESTAMPTZ DEFAULT now(), review TEXT)`).catch(() => {});
    await pool.query(`INSERT INTO ai_reviews (review) VALUES ($1)`, [review]).catch(() => {});
  }
  return { review, basis: undefined };
}
