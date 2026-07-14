import { pool } from '../db';
import { SignalFeatureVector } from '../types';
import { clamp01, deterministicShuffle, round, sigmoid } from './math';
import { MODEL_VERSION } from './version';

const FEATURE_KEYS = [
  'capitalEfficiency','curveSpeed1m','curveSpeed3m','organicBreadth','buyPressure','smartMoney',
  'socialCredibility','buyerIndependence','burstQuality','flowRetention','tradeAcceleration',
  'liquidityDepth','routePrior','graphSafety','burstSafety','runupSafety','deployerSafety',
] as const;
type RankFeature = typeof FEATURE_KEYS[number];
interface RankWeights { bias: number; values: Record<RankFeature, number> }
interface LabeledRow { at: number; group: string; multiple: number; vector: number[] }
interface Pair { difference: number[] }

let active: RankWeights | null = null;
const diag = {
  active: false, trainedAt: null as string | null, samples: 0, trainPairs: 0, validationPairs: 0,
  validationAccuracy: 0, placeboAccuracy: 0, lastError: null as string | null,
};
export const rankLearnerDiag = () => ({ ...diag, featureKeys: FEATURE_KEYS, weights: active });

export function rankVector(features: SignalFeatureVector): number[] {
  return [
    features.capitalEfficiency, features.curveSpeed1m, features.curveSpeed3m,
    features.organicBreadth, features.buyPressure, features.smartMoney,
    features.socialCredibility, features.buyerIndependence, features.burstQuality,
    features.flowRetention, features.tradeAcceleration, features.liquidityDepth,
    features.routePrior, 1 - features.graphRisk, 1 - features.burstExhaustion,
    1 - features.runupPenalty, 1 - features.deployerRisk,
  ].map(clamp01);
}

export function learnedRankScore(features: SignalFeatureVector): number | null {
  if (!active) return null;
  const vector = rankVector(features);
  const linear = active.bias + vector.reduce((sum, value, index) => sum + value * active!.values[FEATURE_KEYS[index]], 0);
  return clamp01(sigmoid(linear));
}

export function trainPairwiseRanker(trainRows: LabeledRow[], validationRows: LabeledRow[]) {
  const trainPairs = buildPairs(trainRows);
  const validationPairs = buildPairs(validationRows);
  const weights = Array(FEATURE_KEYS.length).fill(0) as number[];
  let bias = 0;
  const epochs = 30;
  for (let epoch = 0; epoch < epochs; epoch++) {
    const learningRate = 0.08 / Math.sqrt(epoch + 1);
    for (const pair of deterministicShuffle(trainPairs, 73 + epoch)) {
      const score = bias + dot(weights, pair.difference);
      const probability = sigmoid(score);
      const error = 1 - probability;
      bias = Math.max(-2, Math.min(2, bias + learningRate * error * 0.02));
      for (let index = 0; index < weights.length; index++) {
        weights[index] += learningRate * (error * pair.difference[index] - 0.002 * weights[index]);
        weights[index] = Math.max(-3, Math.min(3, weights[index]));
      }
    }
  }
  const learned: RankWeights = {
    bias: round(bias),
    values: Object.fromEntries(FEATURE_KEYS.map((key, index) => [key, round(weights[index])])) as Record<RankFeature, number>,
  };
  const validationAccuracy = pairAccuracy(validationPairs, weights, bias, false);
  const placeboAccuracy = pairAccuracy(validationPairs, weights, bias, true);
  return { weights: learned, trainPairs: trainPairs.length, validationPairs: validationPairs.length,
    validationAccuracy, placeboAccuracy };
}

export function startPairwiseRankLearner() {
  if (!pool) return;
  loadActive().catch(() => {});
  setTimeout(() => train().catch(() => {}), 10 * 60_000);
  const timer = setInterval(() => train().catch(() => {}), 6 * 3600_000);
  timer.unref();
}

async function loadActive() {
  if (!pool) return;
  const result = await pool.query(
    `SELECT parameters,metrics,trained_at,sample_count FROM model_parameters
      WHERE model_version=$1 AND kind='pairwise_rank' AND active=true
      ORDER BY trained_at DESC LIMIT 1`, [MODEL_VERSION],
  ).catch(() => ({ rows: [] as any[] }));
  if (!result.rows.length) return;
  active = result.rows[0].parameters as RankWeights;
  diag.active = true;
  diag.trainedAt = new Date(result.rows[0].trained_at).toISOString();
  diag.samples = Number(result.rows[0].sample_count) || 0;
  diag.validationAccuracy = Number(result.rows[0].metrics?.validationAccuracy) || 0;
  diag.placeboAccuracy = Number(result.rows[0].metrics?.placeboAccuracy) || 0;
}

async function train() {
  if (!pool) return;
  try {
    const result = await pool.query(
      `SELECT EXTRACT(EPOCH FROM observation.captured_at)*1000 AS at,
              observation.observation_key,observation.regime_id,observation.feature_vector,
              outcome.multiple
         FROM signal_observations observation
         JOIN signal_observation_outcomes outcome ON outcome.observation_id=observation.id AND outcome.horizon_minutes=60
        WHERE observation.model_version=$1 AND observation.recommendation_eligible=true
          AND outcome.status='resolved' AND outcome.multiple IS NOT NULL
          AND observation.captured_at>now()-interval '30 days'
        ORDER BY observation.captured_at`, [MODEL_VERSION],
    );
    const rows: LabeledRow[] = result.rows.map(row => ({
      at: Number(row.at),
      group: `${new Date(Number(row.at)).toISOString().slice(0,13)}:${row.observation_key}:${row.regime_id}`,
      multiple: Number(row.multiple),
      vector: rankVector(row.feature_vector as SignalFeatureVector),
    })).filter(row => Number.isFinite(row.at) && Number.isFinite(row.multiple) && row.vector.every(Number.isFinite));
    diag.samples = rows.length;
    if (rows.length < 200) return;
    const split = Math.floor(rows.length * 0.75);
    const trained = trainPairwiseRanker(rows.slice(0, split), rows.slice(split));
    diag.trainPairs = trained.trainPairs;
    diag.validationPairs = trained.validationPairs;
    diag.validationAccuracy = round(trained.validationAccuracy);
    diag.placeboAccuracy = round(trained.placeboAccuracy);
    diag.trainedAt = new Date().toISOString();
    const safe = trained.trainPairs >= 100 && trained.validationPairs >= 30
      && trained.validationAccuracy >= 0.55
      && trained.validationAccuracy >= trained.placeboAccuracy + 0.03;
    await pool.query(`UPDATE model_parameters SET active=false WHERE model_version=$1 AND kind='pairwise_rank'`, [MODEL_VERSION]);
    await pool.query(
      `INSERT INTO model_parameters (model_version,kind,parameters,metrics,active,sample_count,trained_at)
       VALUES ($1,'pairwise_rank',$2,$3,$4,$5,now())`,
      [MODEL_VERSION, JSON.stringify(trained.weights), JSON.stringify({
        trainPairs: trained.trainPairs, validationPairs: trained.validationPairs,
        validationAccuracy: trained.validationAccuracy, placeboAccuracy: trained.placeboAccuracy,
        chronologicalSplit: 0.75,
      }), safe, rows.length],
    );
    if (safe) { active = trained.weights; diag.active = true; }
    else diag.active = false;
    diag.lastError = null;
  } catch (error) {
    diag.lastError = (error as Error).message;
    console.error('[rank-learner]', diag.lastError);
  }
}

function buildPairs(rows: LabeledRow[]): Pair[] {
  const groups = new Map<string, LabeledRow[]>();
  for (const row of rows) {
    if (!groups.has(row.group)) groups.set(row.group, []);
    groups.get(row.group)!.push(row);
  }
  const pairs: Pair[] = [];
  for (const group of groups.values()) {
    const sorted = [...group].sort((left, right) => right.multiple - left.multiple);
    const count = Math.min(12, Math.floor(sorted.length / 2));
    for (let index = 0; index < count; index++) {
      const winner = sorted[index];
      const loser = sorted[sorted.length - 1 - index];
      if (winner.multiple - loser.multiple < 0.25) continue;
      pairs.push({ difference: winner.vector.map((value, feature) => value - loser.vector[feature]) });
    }
  }
  return pairs;
}
function pairAccuracy(pairs: Pair[], weights: number[], bias: number, placebo: boolean): number {
  if (!pairs.length) return 0;
  let correct = 0;
  for (let index = 0; index < pairs.length; index++) {
    const difference = placebo && index % 2 === 0 ? pairs[index].difference.map(value => -value) : pairs[index].difference;
    if (bias + dot(weights, difference) > 0) correct++;
  }
  return correct / pairs.length;
}
function dot(left: number[], right: number[]): number {
  return left.reduce((sum, value, index) => sum + value * right[index], 0);
}
