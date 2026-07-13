import { cfg, setWeightOverrides, setConfigOverrides, setDirections } from '../config';
import { pool } from '../db';
import { RawScoreFeatures } from '../types';

// SCORING CALIBRATOR
//
// Only normalized raw features captured at the configured young age are eligible
// for training. Legacy `early_subs` rows contain already-weighted values and are
// deliberately ignored: using them would let the old model contaminate the next
// model's estimate of signal importance.

const COMPONENTS = ['freshness', 'velocity', 'buy_pressure', 'organic', 'social', 'smart_money'] as const;
type Component = typeof COMPONENTS[number];

const diag = {
  lastRun: null as string | null,
  lastError: null as string | null,
  samples: 0,
  winners: 0,
  status: 'not_run',
  target: {} as Record<string, number>,
  applied: {} as Record<string, number>,
  floor: 0,
  direction: {} as Record<string, number>,
  dataVersion: 'raw_v1',
};
export const scorecalDiag = () => diag;

export function startScoreCalibrator() {
  if (!pool) return;
  seedFromReport().catch(() => {});
  loadWeights().catch(() => {});
  setTimeout(() => run().catch(() => {}), 4 * 60_000);
  setInterval(() => run().catch(() => {}), 6 * 3600_000);
}

async function seedFromReport() {
  if (!pool) return;
  const seed: Record<string, number> = {
    _dir_freshness: -1,
    _dir_buy_pressure: -1,
    _dir_velocity: 1,
    _dir_organic: 1,
    _dir_social: 1,
    _dir_smart_money: 1,
    freshness: 8,
    buy_pressure: 8,
    velocity: 14,
    organic: 34,
    smart_money: 21,
    social: 15,
    _trigger_floor: 45,
  };
  let wrote = 0;
  for (const [k, v] of Object.entries(seed)) {
    const r = await pool.query(
      `INSERT INTO learned_weights (component, weight) VALUES ($1,$2)
       ON CONFLICT (component) DO NOTHING`, [k, v]);
    wrote += (r as any).rowCount || 0;
  }
  if (wrote > 0) {
    await pool.query(
      `INSERT INTO weight_tuning_log (component, old_weight, new_weight, evidence)
       VALUES ('_seed',0,1,$1)`,
      [`seeded ${wrote} missing keys while raw-v1 forward features accumulate`]).catch(() => {});
    console.log(`[scorecal] seeded ${wrote} missing baseline values`);
  }
}

async function loadWeights() {
  if (!pool) return;
  const r = await pool.query(`SELECT component, weight FROM learned_weights`).catch(() => null);
  if (r && r.rows.length) {
    const weights: Record<string, number> = {};
    for (const row of r.rows) {
      if (!row.component.startsWith('_')) weights[row.component] = Number(row.weight);
    }
    setWeightOverrides(weights);
    diag.applied = weights;
  }

  const stuck = await pool.query(
    `SELECT weight FROM learned_weights WHERE component = '_trigger_floor'`).catch(() => null);
  if (stuck && stuck.rows.length && Number(stuck.rows[0].weight) >= 60) {
    const computed = await pool.query(
      `SELECT 1 FROM weight_tuning_log WHERE component = '_trigger_floor' LIMIT 1`)
      .catch(() => ({ rows: [] as any[] }));
    if (!computed.rows.length) {
      await pool.query(
        `UPDATE learned_weights SET weight = 45, updated_at = now()
         WHERE component = '_trigger_floor'`);
      await pool.query(
        `INSERT INTO weight_tuning_log (component, old_weight, new_weight, evidence)
         VALUES ('_trigger_floor',$1,45,'unstick migration: pre-computation floor')`,
        [Number(stuck.rows[0].weight)]).catch(() => {});
    }
  }

  const floor = await pool.query(
    `SELECT weight FROM learned_weights WHERE component = '_trigger_floor'`).catch(() => null);
  if (floor && floor.rows.length) {
    const value = Number(floor.rows[0].weight);
    setConfigOverrides({ 'states.trigger_score_min': value });
    diag.floor = value;
  }

  const d = await pool.query(
    `SELECT component, weight FROM learned_weights WHERE component LIKE '\_dir\_%'`)
    .catch(() => null);
  if (d && d.rows.length) {
    const dirs: Record<string, number> = {};
    for (const row of d.rows) dirs[row.component.replace('_dir_', '')] = Number(row.weight);
    setDirections(dirs);
    diag.direction = dirs;
  }
}

function asVector(raw: unknown): number[] | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const values = COMPONENTS.map(k => Number((raw as Record<string, unknown>)[k]));
  if (values.some(v => !Number.isFinite(v) || v < 0 || v > 1)) return null;
  return values;
}

function boundedNormalize(target: Record<Component, number>, min: number, max: number): Record<string, number> {
  const result: Partial<Record<Component, number>> = {};
  let free = [...COMPONENTS];
  let remaining = 100;

  while (free.length) {
    const rawSum = free.reduce((sum, k) => sum + Math.max(0, target[k]), 0) || free.length;
    let changed = false;
    for (const k of [...free]) {
      const proposed = remaining * (Math.max(0, target[k]) || 1) / rawSum;
      if (proposed < min) {
        result[k] = min;
        remaining -= min;
        free = free.filter(x => x !== k);
        changed = true;
      } else if (proposed > max) {
        result[k] = max;
        remaining -= max;
        free = free.filter(x => x !== k);
        changed = true;
      }
    }
    if (!changed) {
      const sum = free.reduce((s, k) => s + Math.max(0, target[k]), 0) || free.length;
      for (const k of free) result[k] = remaining * (Math.max(0, target[k]) || 1) / sum;
      break;
    }
  }

  const rounded = Object.fromEntries(COMPONENTS.map(k => [k, round1(result[k] ?? min)]));
  const diff = round1(100 - Object.values(rounded).reduce((s, x) => s + x, 0));
  if (Math.abs(diff) >= 0.1) {
    const adjustable = [...COMPONENTS]
      .sort((a, b) => Math.abs(target[b] - rounded[b]) - Math.abs(target[a] - rounded[a]))
      .find(k => rounded[k] + diff >= min && rounded[k] + diff <= max);
    if (adjustable) rounded[adjustable] = round1(rounded[adjustable] + diff);
  }
  return rounded;
}

function scoreVector(v: number[], weights: Record<string, number>, directions: Record<string, number>): number {
  return COMPONENTS.reduce((sum, k, i) => {
    const value = directions[k] < 0 ? 1 - v[i] : v[i];
    return sum + value * Number(weights[k] ?? 0);
  }, 0);
}

async function tuneFloor(
  win: number[][],
  lose: number[][],
  weights: Record<string, number>,
  directions: Record<string, number>,
) {
  if (!pool) return;
  const c = cfg().calibration;
  const winTot = win.map(v => scoreVector(v, weights, directions));
  const loseTot = lose.map(v => scoreVector(v, weights, directions));
  let bestFloor = cfg().states.trigger_score_min;
  let bestJ = -1;

  for (let floor = 10; floor <= 90; floor += 2) {
    const tpr = winTot.filter(x => x >= floor).length / (winTot.length || 1);
    const fpr = loseTot.filter(x => x >= floor).length / (loseTot.length || 1);
    const j = tpr - fpr;
    if (j > bestJ) {
      bestJ = j;
      bestFloor = floor;
    }
  }

  const current = cfg().states.trigger_score_min;
  const next = Math.round(current + (bestFloor - current) * c.learning_rate);
  if (next === current) return;

  await pool.query(
    `INSERT INTO learned_weights (component, weight) VALUES ('_trigger_floor',$1)
     ON CONFLICT (component) DO UPDATE SET weight=$1, updated_at=now()`, [next]);
  await pool.query(
    `INSERT INTO weight_tuning_log (component, old_weight, new_weight, evidence)
     VALUES ('_trigger_floor',$1,$2,$3)`,
    [current, next, `raw-v1 optimum=${bestFloor}, J=${bestJ.toFixed(3)}, lr=${c.learning_rate}`]);
  setConfigOverrides({ 'states.trigger_score_min': next });
  diag.floor = next;
}

export async function run() {
  if (!pool) return;
  const c = cfg().calibration;
  if (!c?.enabled) return;

  const guard = await pool.query(
    `SELECT MAX(at) AS last FROM weight_tuning_log WHERE component <> '_seed'`)
    .catch(() => ({ rows: [{ last: null }] as any[] }));
  const lastChange = guard.rows[0]?.last ? new Date(guard.rows[0].last).getTime() : 0;
  if (lastChange && Date.now() - lastChange < 5.5 * 3600_000) {
    diag.status = 'cooldown';
    return;
  }

  try {
    diag.lastRun = new Date().toISOString();
    diag.lastError = null;

    const r = await pool.query(`
      SELECT t.early_subs->'raw' AS raw, MAX(o.multiple_from_first) AS best
      FROM tokens t
      JOIN outcomes o ON o.ca = t.ca
      WHERE t.early_subs->'raw' IS NOT NULL
        AND o.multiple_from_first IS NOT NULL
        AND t.first_seen > now() - ($1 || ' days')::interval
      GROUP BY t.ca, t.early_subs->'raw'`, [String(c.window_days)]);

    const labeled = r.rows
      .map(row => ({ vector: asVector(row.raw), best: Number(row.best) }))
      .filter((row): row is { vector: number[]; best: number } => !!row.vector && Number.isFinite(row.best));

    diag.samples = labeled.length;
    if (labeled.length < c.min_samples) {
      diag.status = `collecting raw-v1: need ${c.min_samples}, have ${labeled.length}`;
      return;
    }

    const win = labeled.filter(r => r.best >= c.win_multiple).map(r => r.vector);
    const lose = labeled.filter(r => r.best < c.win_multiple).map(r => r.vector);
    diag.winners = win.length;
    if (win.length < c.min_winners) {
      diag.status = `collecting raw-v1 winners: need ${c.min_winners}, have ${win.length}`;
      return;
    }

    const mean = (a: number[][], i: number) => a.reduce((s, v) => s + v[i], 0) / (a.length || 1);
    const variance = (a: number[][], i: number, m: number) =>
      a.reduce((s, v) => s + (v[i] - m) ** 2, 0) / (a.length || 1);

    const directions: Record<string, number> = {};
    const separation: Record<Component, number> = {} as Record<Component, number>;
    for (let i = 0; i < COMPONENTS.length; i++) {
      const k = COMPONENTS[i];
      const mw = mean(win, i);
      const ml = mean(lose, i);
      const pooled = Math.sqrt((variance(win, i, mw) + variance(lose, i, ml)) / 2) || 1;
      const snr = (mw - ml) / pooled;
      directions[k] = snr >= 0 ? 1 : -1;
      separation[k] = Math.abs(snr);
    }

    const totalSep = Object.values(separation).reduce((s, x) => s + x, 0);
    if (totalSep <= 0) {
      diag.status = 'raw-v1 has no separating signal yet';
      return;
    }

    const target = Object.fromEntries(
      COMPONENTS.map(k => [k, separation[k] / totalSep * 100])) as Record<Component, number>;
    diag.target = round(target);

    const current = cfg().weights as Record<Component, number>;
    const moved = Object.fromEntries(COMPONENTS.map(k => [
      k,
      current[k] + (target[k] - current[k]) * c.learning_rate,
    ])) as Record<Component, number>;
    const next = boundedNormalize(moved, c.min_weight, c.max_weight);

    for (const [k, value] of Object.entries(next)) {
      const before = round1(Number(current[k as Component] ?? 0));
      if (Math.abs(before - value) < 0.5) continue;
      await pool.query(
        `INSERT INTO learned_weights (component, weight) VALUES ($1,$2)
         ON CONFLICT (component) DO UPDATE SET weight=$2, updated_at=now()`, [k, value]);
      await pool.query(
        `INSERT INTO weight_tuning_log (component, old_weight, new_weight, evidence)
         VALUES ($1,$2,$3,$4)`,
        [k, before, value, `${diag.samples} raw-v1 samples / ${diag.winners} winners @ ${c.win_multiple}x; dir=${directions[k]}`]);
    }

    for (const [k, direction] of Object.entries(directions)) {
      await pool.query(
        `INSERT INTO learned_weights (component, weight) VALUES ($1,$2)
         ON CONFLICT (component) DO UPDATE SET weight=$2, updated_at=now()`,
        [`_dir_${k}`, direction]);
    }

    diag.direction = directions;
    await tuneFloor(win, lose, next, directions);
    diag.status = 'applied raw-v1';
    await loadWeights();
    console.log('[scorecal] raw-v1 weights ->', JSON.stringify(round(next)));
  } catch (e) {
    diag.lastError = (e as Error).message;
    diag.status = 'error';
    console.error('[scorecal]', diag.lastError);
  }
}

const round1 = (x: number) => Math.round(x * 10) / 10;
const round = (o: Record<string, number>) =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, round1(v)]));
