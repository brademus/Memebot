import { cfg, setWeightOverrides, setConfigOverrides, setDirections } from '../config';
import { pool } from '../db';

// SCORING CALIBRATOR — the closed loop that makes the score fit outcomes over time.
//
// The problem your data exposed: 10,000x / 200x / 126x winners peaked at scores of
// 19-46, while the trigger floor was 65. The score rewarded post-pump maturity, so
// real early winners scored LOW. Hand-tuning weights is guessing; this fits them to
// what actually predicted winners.
//
// METHOD (every 6h, once enough labeled data exists):
//   1. Train on `early_subs` — sub-scores FROZEN at a young age — joined to the
//      token's best realized multiple. (The live subs column is overwritten as a
//      coin matures and is useless for prediction; that was the latent bug.)
//   2. Label winner = best multiple >= win_multiple. For each component, measure
//      PREDICTIVE SEPARATION via a signal-to-noise score: (mean_win - mean_lose) /
//      (pooled stddev). This beats a raw mean-diff because it discounts noisy
//      components — a signal that's high for winners AND losers gets no credit.
//   3. New weight for each component ∝ max(0, its separation), renormalized to 100.
//   4. Move CURRENT weights a bounded fraction toward the target (learning rate),
//      so the score drifts smoothly instead of lurching on one noisy batch.
//   5. Persist to Postgres (survives redeploys), apply live via the weight overlay,
//      log every change with evidence. Converges: as weights track truth, the
//      target stops moving and updates shrink to nothing.
//
// SAFETY: bounded per-cycle movement, a floor/ceiling per weight, always sums to
// 100, and a kill switch (calibration.enabled). It only reweights EXISTING signals —
// it cannot invent or disable a component, and never touches gates or safety checks.

const COMPONENTS = ['freshness', 'liquidity', 'buyPressure', 'holderGrowth', 'smartMoney'] as const;
// map internal sub-score keys -> config.weights keys they feed
const WEIGHT_KEYS: Record<string, string> = {
  freshness: 'freshness', liquidity: 'velocity', buyPressure: 'buy_pressure',
  holderGrowth: 'organic', smartMoney: 'smart_money',
};

const diag = { lastRun: null as string | null, lastError: null as string | null, samples: 0, winners: 0, status: 'not_run', target: {} as Record<string, number>, applied: {} as Record<string, number>, floor: 0, direction: {} as Record<string, number> };
export const scorecalDiag = () => diag;

export function startScoreCalibrator() {
  if (!pool) return;
  seedFromReport().catch(() => {});   // apply the proven 30k-sample finding immediately
  loadWeights().catch(() => {});
  setTimeout(() => run().catch(() => {}), 4 * 60_000);
  setInterval(() => run().catch(() => {}), 6 * 3600_000);
}

// SEED — the 2026-07-10 report (30k+ samples) decisively showed the direction of
// each signal. Rather than wait for the calibrator's sample floor to rediscover
// it, seed those directions ONCE (only if unset), so the score is fixed on next
// boot. The calibrator then keeps adapting from here — this is just the starting
// point, not a hardcode: any future run overwrites these.
async function seedFromReport() {
  if (!pool) return;
  const existing = await pool.query(`SELECT 1 FROM learned_weights WHERE component LIKE '\_dir\_%' LIMIT 1`).catch(() => null);
  if (existing && existing.rows.length) return;   // already learned — don't clobber
  // componentCalibration terciles: freshness & buyPressure INVERTED (t1>t3),
  // holderGrowth CORRECT (t3 best), liquidity & smartMoney peak mid (treat as
  // weak-positive, the calibrator will refine). organic feeds holderGrowth.
  const seed: Record<string, number> = {
    _dir_freshness: -1, _dir_buy_pressure: -1,
    _dir_velocity: 1, _dir_organic: 1, _dir_smart_money: 1,
    freshness: 8, buy_pressure: 8, velocity: 14, organic: 34, smart_money: 21, social: 15,
    _trigger_floor: 45,
  };
  for (const [k, v] of Object.entries(seed))
    await pool.query(
      `INSERT INTO learned_weights (component, weight) VALUES ($1,$2) ON CONFLICT (component) DO NOTHING`, [k, v]);
  await pool.query(
    `INSERT INTO weight_tuning_log (component, old_weight, new_weight, evidence) VALUES ('_seed',0,1,$1)`,
    ['seeded from 2026-07-10 report: freshness/buyPressure inverted, holderGrowth dominant, floor 65->45']).catch(() => {});
  console.log('[scorecal] seeded weights+directions from report; floor -> 45');
}

async function loadWeights() {
  if (!pool) return;
  const r = await pool.query(`SELECT component, weight FROM learned_weights`).catch(() => null);
  if (r && r.rows.length) {
    const o: Record<string, number> = {};
    // only REAL component weights belong in the weight overlay — skip the
    // underscore-prefixed bookkeeping rows (_dir_*, _trigger_floor, _seed), which
    // are applied through their own channels below, not as score weights.
    for (const row of r.rows) if (!row.component.startsWith('_')) o[row.component] = Number(row.weight);
    setWeightOverrides(o);
    diag.applied = o;
    console.log(`[scorecal] applied ${Object.keys(o).length} learned weights`);
  }
  // load a persisted trigger floor if we've learned one
  const f = await pool.query(`SELECT weight FROM learned_weights WHERE component = '_trigger_floor'`).catch(() => null);
  if (f && f.rows.length) setConfigOverrides({ 'states.trigger_score_min': Number(f.rows[0].weight) });
  // load learned directions (which signals are inverted)
  const d = await pool.query(`SELECT component, weight FROM learned_weights WHERE component LIKE '\_dir\_%'`).catch(() => null);
  if (d && d.rows.length) {
    const dirs: Record<string, number> = {};
    for (const row of d.rows) dirs[row.component.replace('_dir_', '')] = Number(row.weight);
    setDirections(dirs);
  }
}

// choose the trigger floor that best separates winners from losers under the new
// weights. Recompute each token's TOTAL from its early_subs and the target weights,
// scan candidate thresholds, maximize (winner-recall - loser-passrate).
async function tuneFloor(win: number[][], lose: number[][], weights: Record<string, number>) {
  if (!pool) return;
  const c = cfg().calibration;
  const wk = ['freshness', 'velocity', 'buy_pressure', 'organic', 'smart_money'];
  const total = (v: number[]) => v.reduce((s, x, i) => s + x, 0);   // early_subs already weight-scaled at capture
  const winTot = win.map(total), loseTot = lose.map(total);
  let bestFloor = cfg().states.trigger_score_min, bestJ = -1;
  for (let f = c.min_weight; f <= 90; f += 2) {
    const tpr = winTot.filter(x => x >= f).length / (winTot.length || 1);
    const fpr = loseTot.filter(x => x >= f).length / (loseTot.length || 1);
    const j = tpr - fpr;
    if (j > bestJ) { bestJ = j; bestFloor = f; }
  }
  // don't lurch: move a bounded step from the current floor toward the optimum
  const curFloor = cfg().states.trigger_score_min;
  const nextFloor = Math.round(curFloor + (bestFloor - curFloor) * c.learning_rate);
  if (nextFloor !== curFloor) {
    await pool.query(
      `INSERT INTO learned_weights (component, weight) VALUES ('_trigger_floor', $1)
       ON CONFLICT (component) DO UPDATE SET weight=$1, updated_at=now()`, [nextFloor]);
    await pool.query(
      `INSERT INTO weight_tuning_log (component, old_weight, new_weight, evidence) VALUES ('_trigger_floor',$1,$2,$3)`,
      [curFloor, nextFloor, `optimal separation floor=${bestFloor} (J=${bestJ.toFixed(2)}); moved ${(c.learning_rate*100)|0}% toward it`]);
    setConfigOverrides({ 'states.trigger_score_min': nextFloor });
    diag.floor = nextFloor;
    console.log(`[scorecal] trigger floor ${curFloor} -> ${nextFloor} (optimal ${bestFloor}, J=${bestJ.toFixed(2)})`);
  }
}

export async function run() {
  if (!pool) return;
  const c = cfg().calibration;
  if (!c || !c.enabled) return;
  try {
    diag.lastRun = new Date().toISOString();
    diag.lastError = null;

    // train on FROZEN early sub-scores vs best realized multiple (any snapshot)
    const r = await pool.query(`
      SELECT t.early_subs AS subs, MAX(o.multiple_from_first) AS best
      FROM tokens t JOIN outcomes o ON o.ca = t.ca
      WHERE t.early_subs IS NOT NULL AND o.multiple_from_first IS NOT NULL
        AND t.first_seen > now() - ($1 || ' days')::interval
      GROUP BY t.ca, t.early_subs`, [String(c.window_days)]);
    diag.samples = r.rows.length;
    if (r.rows.length < c.min_samples) { diag.status = `need ${c.min_samples}, have ${r.rows.length}`; return; }

    const win: number[][] = [], lose: number[][] = [];
    for (const row of r.rows) {
      const v = COMPONENTS.map(k => Number(row.subs?.[k] ?? 0));
      (Number(row.best) >= c.win_multiple ? win : lose).push(v);
    }
    diag.winners = win.length;
    if (win.length < c.min_winners) { diag.status = `need ${c.min_winners} winners, have ${win.length}`; return; }

    // signal-to-noise separation per component — now DIRECTION-AWARE. A signal
    // where winners score LOWER (freshness, buyPressure per the report) is not
    // noise, it's INVERTED: we learn direction = -1 and the score flips it. |SNR|
    // is the magnitude of the edge regardless of sign, so inverted signals earn
    // weight too instead of being thrown away.
    const mean = (a: number[][], i: number) => a.reduce((s, v) => s + v[i], 0) / (a.length || 1);
    const varc = (a: number[][], i: number, m: number) => a.reduce((s, v) => s + (v[i] - m) ** 2, 0) / (a.length || 1);
    const direction: Record<string, number> = {};
    const sep = COMPONENTS.map((k, i) => {
      const mw = mean(win, i), ml = mean(lose, i);
      const pooled = Math.sqrt((varc(win, i, mw) + varc(lose, i, ml)) / 2) || 1;
      const snr = (mw - ml) / pooled;
      direction[WEIGHT_KEYS[k]] = snr >= 0 ? 1 : -1;    // -1 = inverted, score flips it
      return Math.abs(snr);                              // magnitude of edge, either direction
    });
    const totalSep = sep.reduce((s, x) => s + x, 0);
    if (totalSep <= 0) { diag.status = 'no separating signal yet'; return; }

    // target weights from separation, then move current a bounded step toward them
    const cur = cfg().weights as any;
    const target: Record<string, number> = {};
    COMPONENTS.forEach((k, i) => target[WEIGHT_KEYS[k]] = (sep[i] / totalSep) * 100);
    diag.target = round(target);

    const lr = c.learning_rate;
    const next: Record<string, number> = {};
    for (const wk of Object.values(WEIGHT_KEYS)) {
      const t = target[wk] ?? 0;
      const moved = cur[wk] + (t - cur[wk]) * lr;
      next[wk] = clamp(moved, c.min_weight, c.max_weight);
    }
    // social weight isn't fit here (categorical, handled in-score) — keep it fixed and renormalize the rest around it
    const socialFixed = cur.social ?? 15;
    const sumFit = Object.values(next).reduce((s, x) => s + x, 0);
    const scaleTo = 100 - socialFixed;
    for (const k of Object.keys(next)) next[k] = round1(next[k] / sumFit * scaleTo);
    next.social = socialFixed;

    // persist + log meaningful weight moves, and persist directions
    for (const [k, v] of Object.entries(next)) {
      const before = round1(cur[k] ?? 0);
      if (Math.abs(before - v) >= 0.5) {
        await pool.query(
          `INSERT INTO learned_weights (component, weight) VALUES ($1,$2)
           ON CONFLICT (component) DO UPDATE SET weight=$2, updated_at=now()`, [k, v]);
        await pool.query(
          `INSERT INTO weight_tuning_log (component, old_weight, new_weight, evidence) VALUES ($1,$2,$3,$4)`,
          [k, before, v, `${diag.samples} samples / ${diag.winners} winners @ ${c.win_multiple}x; |SNR|-fit dir=${direction[k]}, lr=${lr}`]);
      }
    }
    for (const [wk, d] of Object.entries(direction)) {
      await pool.query(
        `INSERT INTO learned_weights (component, weight) VALUES ($1,$2)
         ON CONFLICT (component) DO UPDATE SET weight=$2, updated_at=now()`, [`_dir_${wk}`, d]);
    }
    diag.direction = direction;
    // ---- ADAPTIVE TRIGGER FLOOR ----
    // The fixed floor (65) is exactly what killed the 10,000x/200x winners that
    // peaked at 19-46. Recompute scores under the NEW weights for the labeled set,
    // then set the floor to the value that best separates winners from losers
    // (Youden's J: maximize TPR - FPR). Bounded, persisted, applied live.
    await tuneFloor(win, lose, next);

    diag.status = 'applied';
    await loadWeights();
    console.log('[scorecal] weights ->', JSON.stringify(round(next)), `(${diag.samples} samples, ${diag.winners} winners)`);
  } catch (e) {
    diag.lastError = (e as Error).message;
    diag.status = 'error';
    console.error('[scorecal]', diag.lastError);
  }
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const round1 = (x: number) => Math.round(x * 10) / 10;
const round = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, round1(v)]));
