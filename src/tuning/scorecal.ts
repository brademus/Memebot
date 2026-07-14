import { cfg } from '../config';
import { pool } from '../db';
import { MODEL_VERSION } from '../model/version';
import { RawScoreFeatures } from '../types';

const COMPONENTS = ['freshness', 'velocity', 'buy_pressure', 'organic', 'social', 'smart_money'] as const;
type Component = typeof COMPONENTS[number];

const diag = {
  lastRun: null as string | null,
  lastError: null as string | null,
  samples: 0,
  winners: 0,
  status: 'not_run',
  target: {} as Record<string, number>,
  suggested: {} as Record<string, number>,
  suggestedFloor: 0,
  direction: {} as Record<string, number>,
  dataVersion: MODEL_VERSION,
  mode: 'suggest_only',
  applied: false,
};

export const scorecalDiag = () => ({ ...diag });

export function startScoreCalibrator() {
  if (!pool) return;
  setTimeout(() => run().catch(() => {}), 4 * 60_000);
  setInterval(() => run().catch(() => {}), 6 * 3600_000);
}

function asVector(raw: unknown): number[] | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const values = COMPONENTS.map(key => Number((raw as Record<string, unknown>)[key]));
  if (values.some(value => !Number.isFinite(value) || value < 0 || value > 1)) return null;
  return values;
}

function boundedNormalize(target: Record<Component, number>, min: number, max: number): Record<string, number> {
  const result: Partial<Record<Component, number>> = {};
  let free = [...COMPONENTS];
  let remaining = 100;

  while (free.length) {
    const rawSum = free.reduce((sum, key) => sum + Math.max(0, target[key]), 0) || free.length;
    let changed = false;
    for (const key of [...free]) {
      const proposed = remaining * (Math.max(0, target[key]) || 1) / rawSum;
      if (proposed < min) {
        result[key] = min;
        remaining -= min;
        free = free.filter(item => item !== key);
        changed = true;
      } else if (proposed > max) {
        result[key] = max;
        remaining -= max;
        free = free.filter(item => item !== key);
        changed = true;
      }
    }
    if (!changed) {
      const sum = free.reduce((total, key) => total + Math.max(0, target[key]), 0) || free.length;
      for (const key of free) result[key] = remaining * (Math.max(0, target[key]) || 1) / sum;
      break;
    }
  }

  const rounded = Object.fromEntries(COMPONENTS.map(key => [key, round1(result[key] ?? min)]));
  const diff = round1(100 - Object.values(rounded).reduce((sum, value) => sum + value, 0));
  const adjustable = [...COMPONENTS].find(key => rounded[key] + diff >= min && rounded[key] + diff <= max);
  if (adjustable && Math.abs(diff) >= 0.1) rounded[adjustable] = round1(rounded[adjustable] + diff);
  return rounded;
}

function scoreVector(vector: number[], weights: Record<string, number>, directions: Record<string, number>): number {
  return COMPONENTS.reduce((sum, key, index) => {
    const value = directions[key] < 0 ? 1 - vector[index] : vector[index];
    return sum + value * Number(weights[key] ?? 0);
  }, 0);
}

function optimumFloor(
  winners: number[][],
  losers: number[][],
  weights: Record<string, number>,
  directions: Record<string, number>,
): { floor: number; j: number } {
  const winnerScores = winners.map(vector => scoreVector(vector, weights, directions));
  const loserScores = losers.map(vector => scoreVector(vector, weights, directions));
  let bestFloor = cfg().states.trigger_score_min;
  let bestJ = -1;
  for (let floor = 10; floor <= 90; floor += 2) {
    const tpr = winnerScores.filter(score => score >= floor).length / (winnerScores.length || 1);
    const fpr = loserScores.filter(score => score >= floor).length / (loserScores.length || 1);
    const j = tpr - fpr;
    if (j > bestJ) {
      bestJ = j;
      bestFloor = floor;
    }
  }
  return { floor: bestFloor, j: bestJ };
}

export async function run() {
  if (!pool || !cfg().calibration?.enabled) return;
  try {
    diag.lastRun = new Date().toISOString();
    diag.lastError = null;

    const result = await pool.query(
      `SELECT raw, forward_multiple
         FROM score_snapshots
        WHERE model_version=$1
          AND recommendation_eligible=true
          AND resolve_status='resolved'
          AND forward_multiple IS NOT NULL
          AND captured_at > now()-($2 || ' days')::interval`,
      [MODEL_VERSION, String(cfg().calibration.window_days)],
    );

    const labeled = result.rows
      .map(row => ({ vector: asVector(row.raw), multiple: Number(row.forward_multiple) }))
      .filter((row): row is { vector: number[]; multiple: number } => !!row.vector && Number.isFinite(row.multiple));

    diag.samples = labeled.length;
    if (labeled.length < cfg().calibration.min_samples) {
      diag.status = `collecting exact forward rows: need ${cfg().calibration.min_samples}, have ${labeled.length}`;
      return;
    }

    const winners = labeled.filter(row => row.multiple >= cfg().calibration.win_multiple).map(row => row.vector);
    const losers = labeled.filter(row => row.multiple < cfg().calibration.win_multiple).map(row => row.vector);
    diag.winners = winners.length;
    if (winners.length < cfg().calibration.min_winners) {
      diag.status = `collecting exact forward winners: need ${cfg().calibration.min_winners}, have ${winners.length}`;
      return;
    }

    const mean = (rows: number[][], index: number) => rows.reduce((sum, row) => sum + row[index], 0) / (rows.length || 1);
    const variance = (rows: number[][], index: number, average: number) =>
      rows.reduce((sum, row) => sum + (row[index] - average) ** 2, 0) / (rows.length || 1);

    const directions: Record<string, number> = {};
    const separation = {} as Record<Component, number>;
    for (let index = 0; index < COMPONENTS.length; index++) {
      const key = COMPONENTS[index];
      const winnerMean = mean(winners, index);
      const loserMean = mean(losers, index);
      const pooled = Math.sqrt((variance(winners, index, winnerMean) + variance(losers, index, loserMean)) / 2) || 1;
      const signal = (winnerMean - loserMean) / pooled;
      directions[key] = signal >= 0 ? 1 : -1;
      separation[key] = Math.abs(signal);
    }

    const total = Object.values(separation).reduce((sum, value) => sum + value, 0);
    if (total <= 0) {
      diag.status = 'exact forward rows have no separating signal yet';
      return;
    }

    const target = Object.fromEntries(COMPONENTS.map(key => [key, separation[key] / total * 100])) as Record<Component, number>;
    const current = cfg().weights as Record<Component, number>;
    const moved = Object.fromEntries(COMPONENTS.map(key => [
      key,
      current[key] + (target[key] - current[key]) * cfg().calibration.learning_rate,
    ])) as Record<Component, number>;
    const suggested = boundedNormalize(moved, cfg().calibration.min_weight, cfg().calibration.max_weight);
    const floor = optimumFloor(winners, losers, suggested, directions);

    diag.target = round(target);
    diag.suggested = suggested;
    diag.suggestedFloor = floor.floor;
    diag.direction = directions;
    diag.status = 'suggestion_ready_not_applied';

    const payload = {
      weights: suggested,
      directions,
      trigger_floor: floor.floor,
      current_weights: current,
      current_floor: cfg().states.trigger_score_min,
      samples: labeled.length,
      winners: winners.length,
      target_multiple: cfg().calibration.win_multiple,
      forward_minutes: 60,
      youden_j: round1(floor.j),
    };
    await pool.query(
      `INSERT INTO model_suggestions (model_version, kind, payload, evidence, applied)
       VALUES ($1,'score_calibration',$2,$3,false)`,
      [MODEL_VERSION, JSON.stringify(payload), `${labeled.length} exact-time rows / ${winners.length} forward ${cfg().calibration.win_multiple}x winners`],
    );
    console.log('[scorecal] suggestion recorded; live weights and trigger floor unchanged');
  } catch (error) {
    diag.lastError = (error as Error).message;
    diag.status = 'error';
    console.error('[scorecal]', diag.lastError);
  }
}

const round1 = (value: number) => Math.round(value * 10) / 10;
const round = (object: Record<string, number>) =>
  Object.fromEntries(Object.entries(object).map(([key, value]) => [key, round1(value)]));
