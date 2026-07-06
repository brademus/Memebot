import { pool } from '../db';

// Outcome-driven weight tuning (suggest-only — a human applies changes to config.yaml).
// Nightly: join scored tokens with their 4h outcomes, label winners (>=2x from first score),
// measure how well each sub-score separates winners from losers, suggest new weights
// proportional to that separation. Deliberately NOT auto-applied: with few samples the
// suggestions are noise, and silently self-modifying scoring is how bots quietly break.
export function startAutotune() {
  setInterval(run, 24 * 60 * 60_000);
  setTimeout(run, 60_000);   // one pass shortly after boot so /api/tuning has data
}

async function run() {
  if (!pool) return;
  try {
    const r = await pool.query(`
      SELECT t.subs, o.multiple_from_first
      FROM tokens t JOIN outcomes o ON o.ca = t.ca AND o.snapshot_minutes = 240
      WHERE t.gate_result = 'passed' AND t.subs IS NOT NULL AND o.multiple_from_first IS NOT NULL`);
    const rows = r.rows;
    if (rows.length < 50) {
      await save({ status: `insufficient_data_${rows.length}_of_50`, weights: null, samples: rows.length });
      return;
    }
    const keys = ['freshness', 'liquidity', 'buyPressure', 'holderGrowth', 'smartMoney'];
    const win: number[][] = [], lose: number[][] = [];
    for (const row of rows) {
      const v = keys.map(k => Number(row.subs?.[k] ?? 0));
      (Number(row.multiple_from_first) >= 2 ? win : lose).push(v);
    }
    if (win.length < 10) {
      await save({ status: `too_few_winners_${win.length}`, weights: null, samples: rows.length });
      return;
    }
    const mean = (arr: number[][], i: number) => arr.reduce((s, v) => s + v[i], 0) / arr.length;
    const sep = keys.map((_, i) => Math.max(0.01, mean(win, i) - mean(lose, i)));
    const total = sep.reduce((s, x) => s + x, 0);
    const suggested: Record<string, number> = {};
    const names = ['freshness', 'liquidity_health', 'buy_pressure', 'holder_growth', 'smart_money'];
    names.forEach((n, i) => suggested[n] = Math.round((sep[i] / total) * 100));
    await save({ status: 'ok', weights: suggested, samples: rows.length, winners: win.length });
    console.log('[autotune] suggestion:', JSON.stringify(suggested), `(${rows.length} samples, ${win.length} winners)`);
  } catch (e) { console.error('[autotune]', (e as Error).message); }
}

let latest: any = { status: 'not_run_yet' };
async function save(s: any) {
  latest = { ...s, at: new Date().toISOString() };
  if (pool) await pool.query(
    `CREATE TABLE IF NOT EXISTS tuning_suggestions (at TIMESTAMPTZ DEFAULT now(), suggestion JSONB);
     INSERT INTO tuning_suggestions (suggestion) VALUES ($1)`, [JSON.stringify(latest)]).catch(() => {});
}
export const latestSuggestion = () => latest;
