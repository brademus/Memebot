"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runAiReview = runAiReview;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const config_1 = require("../config");
const gemini_1 = require("./gemini");
const report_1 = require("../api/report");
const autotune_1 = require("../tuning/autotune");
const db_1 = require("../db");
// AI REVIEWER — the "analyze everything and make it better" loop, done honestly.
// Pro-tier Gemini reads: (1) full performance report (trigger outcomes, score
// calibration, false kills, insider correlation), (2) the live config, (3) the
// autotune statistical suggestion — and writes a tuning review with specific
// config.yaml changes and its reasoning.
//
// SUGGEST-ONLY BY DESIGN: it never edits config itself. The human reads the
// review and applies changes. An AI silently rewriting the scoring of a money
// bot is how systems quietly break — the review is the product, not the edit.
async function runAiReview() {
    const basis = {
        report: await (0, report_1.buildReport)(),
        autotuneSuggestion: (0, autotune_1.latestSuggestion)(),
        currentConfig: fs_1.default.readFileSync(path_1.default.join(process.cwd(), 'config.yaml'), 'utf8'),
    };
    if (!config_1.env.GEMINI_API_KEY)
        return { review: null, basis };
    const prompt = `You are the performance reviewer for a Solana memecoin scanner bot.
Below is (A) its outcome report, (B) its current config.yaml, (C) a statistical weight suggestion from its autotuner.

Write a tuning review with exactly these sections:
1. WORKING: what the data shows is working (cite the numbers).
2. NOT WORKING: where the algorithm is losing (false kills, miscalibrated score bands, bad thresholds — cite numbers).
3. CHANGES: specific config.yaml edits, as "key: current -> proposed", each with one line of reasoning grounded in the data. If autotune's weights disagree with your read, say which to trust and why.
4. NOT ENOUGH DATA: which conclusions can't be drawn yet and what sample size is needed.
Be blunt and numeric. If the dataset is too small for any confident change, say so plainly and recommend waiting — do not invent changes to seem useful.

(A) REPORT: ${JSON.stringify(basis.report)}
(B) CONFIG: ${basis.currentConfig}
(C) AUTOTUNE: ${JSON.stringify(basis.autotuneSuggestion)}`;
    const review = await (0, gemini_1.gemini)(prompt, (0, config_1.cfg)().ai.review_model, 1500);
    if (review && db_1.pool) {
        await db_1.pool.query(`CREATE TABLE IF NOT EXISTS ai_reviews (at TIMESTAMPTZ DEFAULT now(), review TEXT)`).catch(() => { });
        await db_1.pool.query(`INSERT INTO ai_reviews (review) VALUES ($1)`, [review]).catch(() => { });
    }
    return { review, basis: undefined };
}
