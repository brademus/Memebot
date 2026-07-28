import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { cfg } from '../config';
import { pool } from '../db';
import { MODEL_VERSION } from '../model/version';
import { quoteExecutableExit } from '../paper/execution';
import {
  ADAPTIVE_EXIT_POLICY,
  STRATEGY_VERSION,
  strategyNotionalUsd,
} from '../paper/strategy-policy';

/**
 * Evidence System v3
 *
 * This worker is deliberately separate from the live strategy. It adds:
 *   1. automatic policy fingerprints and immutable evidence epochs;
 *   2. append-only execution-attempt journaling via database triggers;
 *   3. paired counterfactual entry policies evaluated on the same candidates;
 *   4. one post-exit shadow per actual parent trade/exit;
 *   5. execution-quoted partial-runner experiments after verified 3x exits; and
 *   6. a one-change-at-a-time experiment recommendation queue.
 *
 * It never signs or broadcasts a transaction and never changes production gates.
 */

const POLICY_SCHEMA_VERSION = 'evidence-system-v3';
const TICK_MS = 30_000;
const PRICE_FRESH_MS = 30 * 60_000;
const SHADOW_MAX_AGE_MS = 24 * 60 * 60_000;
const ASSESSMENT_EVERY_MS = 5 * 60_000;
const EXPERIMENT_EVERY_MS = 30 * 60_000;

export interface PairedMetrics {
  evidenceReady: boolean;
  persistenceReady: boolean;
  burstCooled: boolean;
  tooLate: boolean;
  sourceEligible: boolean;
  modelAllows: boolean;
  state: string | null;
}

export type PairedPolicyId =
  | 'control_current'
  | 'late_ceiling_plus_25pct'
  | 'persistence_one_check_relaxed'
  | 'burst_cooldown_relaxed';

export interface ExperimentCandidate {
  sourceLayer: 'gate' | 'entry';
  reasonCode: string;
  total: number;
  missed3x: number;
  severeLosses: number;
}

const PAIRED_POLICIES: PairedPolicyId[] = [
  'control_current',
  'late_ceiling_plus_25pct',
  'persistence_one_check_relaxed',
  'burst_cooldown_relaxed',
];

const RUNNER_VARIANTS = [
  { id: 'full_exit_3x', soldFraction: 1, runnerFraction: 0, trailPct: 0 },
  { id: 'runner_75_25', soldFraction: 0.75, runnerFraction: 0.25, trailPct: 0.25 },
  { id: 'runner_80_20', soldFraction: 0.80, runnerFraction: 0.20, trailPct: 0.25 },
  { id: 'conditional_50_50', soldFraction: 0.50, runnerFraction: 0.50, trailPct: 0.20 },
] as const;

const diag = {
  initialized: false,
  policyFingerprint: null as string | null,
  policyEpochStartedAt: null as string | null,
  policyRotations: 0,
  pairedEntriesOpened: 0,
  pairedEntriesClosed: 0,
  perExitShadowsOpened: 0,
  runnerVariantsOpened: 0,
  runnerVariantsClosed: 0,
  recommendationsWritten: 0,
  lastTickAt: null as string | null,
  lastSuccessAt: null as string | null,
  lastError: null as string | null,
};

let started = false;
let running = false;
let lastAssessmentAt = 0;
let lastExperimentAt = 0;
let currentFingerprint: string | null = null;

export const evidenceSystemV3Diag = () => ({ ...diag });

function asObject(value: unknown): Record<string, any> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, any>;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {}
  }
  return {};
}

function numberOrNull(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${stableStringify(object[key])}`).join(',')}}`;
}

function sourceCommit(): string {
  return process.env.RAILWAY_GIT_COMMIT_SHA
    || process.env.VERCEL_GIT_COMMIT_SHA
    || process.env.GIT_COMMIT_SHA
    || 'unknown-commit';
}

function policyPayload(): Record<string, unknown> {
  const config = cfg() as any;
  return {
    schemaVersion: POLICY_SCHEMA_VERSION,
    sourceCommit: sourceCommit(),
    modelVersion: MODEL_VERSION,
    strategyVersion: STRATEGY_VERSION,
    strategyNotionalUsd: strategyNotionalUsd(),
    adaptiveExitPolicy: ADAPTIVE_EXIT_POLICY,
    config: {
      gates: config.gates,
      prefilter: config.prefilter,
      tractionFloor: config.traction_floor,
      deployer: config.deployer,
      bundle: config.bundle,
      age: config.age,
      weights: config.weights,
      states: config.states,
      bestbuys: config.bestbuys,
      paper: config.paper,
      signalModel: config.signal_model,
      conviction: config.conviction,
      learning: config.learning,
      momentum: config.momentum,
      aged: config.aged,
      calibration: config.calibration,
    },
  };
}

export function policyFingerprintFor(payload: unknown): string {
  return createHash('sha256').update(stableStringify(payload)).digest('hex');
}

function currentPolicy(): { fingerprint: string; payload: Record<string, unknown> } {
  const payload = policyPayload();
  return { fingerprint: policyFingerprintFor(payload), payload };
}

export function evaluatePairedVariant(policyId: PairedPolicyId, metrics: PairedMetrics): boolean {
  if (metrics.state === 'DYING' || metrics.state === 'DEAD' || metrics.state === 'EXTENDED') return false;
  if (!metrics.evidenceReady || !metrics.sourceEligible || !metrics.modelAllows) return false;
  if (policyId !== 'persistence_one_check_relaxed' && !metrics.persistenceReady) return false;
  if (policyId !== 'burst_cooldown_relaxed' && !metrics.burstCooled) return false;
  if (policyId !== 'late_ceiling_plus_25pct' && metrics.tooLate) return false;
  return true;
}

export function runnerStopMultiple(peakMultiple: number, trailPct: number): number {
  if (!Number.isFinite(peakMultiple) || peakMultiple <= 0) return 3;
  return Math.max(3, peakMultiple * (1 - Math.max(0, Math.min(0.9, trailPct))));
}

export function rankExperimentCandidates(candidates: ExperimentCandidate[]): Array<ExperimentCandidate & {
  missedRate: number;
  severeLossRate: number;
  score: number;
}> {
  return candidates
    .filter(candidate => candidate.total >= 20 && candidate.missed3x >= 3)
    .map(candidate => {
      const missedRate = candidate.missed3x / candidate.total;
      const severeLossRate = candidate.severeLosses / candidate.total;
      return {
        ...candidate,
        missedRate,
        severeLossRate,
        // A missed 3x is valuable, but a severe-loss admission is deliberately
        // penalized more heavily. This only ranks a shadow experiment; it never
        // changes a gate automatically.
        score: missedRate - 1.5 * severeLossRate,
      };
    })
    .sort((left, right) => right.score - left.score || right.missed3x - left.missed3x);
}

async function ensureSchema() {
  if (!pool) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS evidence_policy_epochs (
    fingerprint TEXT PRIMARY KEY,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at TIMESTAMPTZ,
    source_commit TEXT NOT NULL,
    model_version TEXT NOT NULL,
    strategy_version TEXT NOT NULL,
    payload JSONB NOT NULL
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS evidence_policy_active (
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
    fingerprint TEXT NOT NULL REFERENCES evidence_policy_epochs(fingerprint),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS evidence_policy_events (
    id BIGSERIAL PRIMARY KEY,
    previous_fingerprint TEXT,
    next_fingerprint TEXT NOT NULL,
    changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    reason TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb
  )`);
  await pool.query(`ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS policy_fingerprint TEXT`);

  await pool.query(`CREATE TABLE IF NOT EXISTS execution_attempts (
    id BIGSERIAL PRIMARY KEY,
    paper_trade_id BIGINT NOT NULL REFERENCES paper_trades(id) ON DELETE CASCADE,
    ca TEXT NOT NULL,
    stage TEXT NOT NULL CHECK (stage IN ('entry','exit')),
    observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    policy_fingerprint TEXT,
    status TEXT,
    evidence JSONB NOT NULL,
    evidence_hash TEXT NOT NULL,
    UNIQUE (paper_trade_id,stage,evidence_hash)
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_execution_attempts_trade_at
    ON execution_attempts(paper_trade_id,observed_at)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_execution_attempts_policy_stage
    ON execution_attempts(policy_fingerprint,stage,observed_at)`);

  await pool.query(`CREATE OR REPLACE FUNCTION stamp_active_policy_fingerprint()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.policy_fingerprint IS NULL THEN
        SELECT fingerprint INTO NEW.policy_fingerprint FROM evidence_policy_active WHERE singleton=TRUE;
      END IF;
      RETURN NEW;
    END $$`);
  await pool.query(`DROP TRIGGER IF EXISTS trg_stamp_active_policy_fingerprint ON paper_trades`);
  await pool.query(`CREATE TRIGGER trg_stamp_active_policy_fingerprint
    BEFORE INSERT OR UPDATE ON paper_trades FOR EACH ROW
    EXECUTE FUNCTION stamp_active_policy_fingerprint()`);

  await pool.query(`CREATE OR REPLACE FUNCTION append_execution_attempt()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE entry_payload JSONB; exit_payload JSONB;
    BEGIN
      IF TG_OP='INSERT' OR NEW.quote_status IS DISTINCT FROM OLD.quote_status
        OR NEW.execution_eligible IS DISTINCT FROM OLD.execution_eligible
        OR NEW.position_usd IS DISTINCT FROM OLD.position_usd
        OR NEW.quoted_out_amount IS DISTINCT FROM OLD.quoted_out_amount
        OR NEW.transaction_built IS DISTINCT FROM OLD.transaction_built
        OR NEW.simulation_ok IS DISTINCT FROM OLD.simulation_ok
        OR NEW.simulation_error IS DISTINCT FROM OLD.simulation_error THEN
        entry_payload := jsonb_build_object(
          'quoteStatus',NEW.quote_status,'eligible',NEW.execution_eligible,
          'positionSol',NEW.position_sol,'positionUsd',NEW.position_usd,
          'quotedOutUsd',NEW.quoted_out_usd,'quotedOutAmount',NEW.quoted_out_amount,
          'priceImpactPct',NEW.price_impact_pct,'slippageBps',NEW.slippage_bps,
          'feeLamports',NEW.fee_lamports,'router',NEW.router,'quoteTimeMs',NEW.quote_time_ms,
          'transactionBuilt',NEW.transaction_built,'simulationOk',NEW.simulation_ok,
          'simulationError',NEW.simulation_error,'simulationUnits',NEW.simulation_units,
          'routeStabilityBps',NEW.route_stability_bps,'executionScore',NEW.execution_score,
          'executionProbe',NEW.execution_probe
        );
        INSERT INTO execution_attempts(paper_trade_id,ca,stage,policy_fingerprint,status,evidence,evidence_hash)
        VALUES(NEW.id,NEW.ca,'entry',NEW.policy_fingerprint,NEW.quote_status,entry_payload,md5(entry_payload::text))
        ON CONFLICT DO NOTHING;
      END IF;
      IF TG_OP='UPDATE' AND (NEW.exit_quote_status IS DISTINCT FROM OLD.exit_quote_status
        OR NEW.exit_quoted_usd IS DISTINCT FROM OLD.exit_quoted_usd
        OR NEW.exit_transaction_built IS DISTINCT FROM OLD.exit_transaction_built
        OR NEW.exit_simulation_ok IS DISTINCT FROM OLD.exit_simulation_ok
        OR NEW.exit_simulation_error IS DISTINCT FROM OLD.exit_simulation_error) THEN
        exit_payload := jsonb_build_object(
          'quoteStatus',NEW.exit_quote_status,'quotedUsd',NEW.exit_quoted_usd,
          'priceImpactPct',NEW.exit_price_impact_pct,'feeLamports',NEW.exit_fee_lamports,
          'router',NEW.exit_router,'quoteTimeMs',NEW.exit_quote_time_ms,
          'transactionBuilt',NEW.exit_transaction_built,'simulationOk',NEW.exit_simulation_ok,
          'simulationError',NEW.exit_simulation_error,'exitReason',NEW.exit_reason
        );
        INSERT INTO execution_attempts(paper_trade_id,ca,stage,policy_fingerprint,status,evidence,evidence_hash)
        VALUES(NEW.id,NEW.ca,'exit',NEW.policy_fingerprint,NEW.exit_quote_status,exit_payload,md5(exit_payload::text))
        ON CONFLICT DO NOTHING;
      END IF;
      RETURN NEW;
    END $$`);
  await pool.query(`DROP TRIGGER IF EXISTS trg_append_execution_attempt ON paper_trades`);
  await pool.query(`CREATE TRIGGER trg_append_execution_attempt
    AFTER INSERT OR UPDATE ON paper_trades FOR EACH ROW
    EXECUTE FUNCTION append_execution_attempt()`);

  await pool.query(`CREATE TABLE IF NOT EXISTS paired_policy_observations (
    id BIGSERIAL PRIMARY KEY,
    quality_trade_id BIGINT NOT NULL REFERENCES paper_trades(id) ON DELETE CASCADE,
    ca TEXT NOT NULL,
    symbol TEXT,
    model_version TEXT NOT NULL,
    policy_fingerprint TEXT NOT NULL,
    policy_id TEXT NOT NULL,
    entry_at TIMESTAMPTZ NOT NULL,
    entry_price NUMERIC NOT NULL,
    peak_price NUMERIC NOT NULL,
    trough_price NUMERIC NOT NULL,
    last_price NUMERIC NOT NULL,
    last_at TIMESTAMPTZ NOT NULL,
    state TEXT NOT NULL DEFAULT 'open',
    close_reason TEXT,
    closed_at TIMESTAMPTZ,
    exit_multiple NUMERIC,
    target_hit BOOLEAN NOT NULL DEFAULT FALSE,
    severe_loss BOOLEAN NOT NULL DEFAULT FALSE,
    source_decision_id BIGINT,
    entry_metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
    UNIQUE(quality_trade_id,policy_fingerprint,policy_id)
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_paired_policy_open
    ON paired_policy_observations(state,last_at)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS paired_policy_assessments (
    policy_fingerprint TEXT NOT NULL,
    variant_policy_id TEXT NOT NULL,
    evaluated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    paired_resolved INT NOT NULL,
    control_target_rate NUMERIC,
    variant_target_rate NUMERIC,
    target_rate_lift NUMERIC,
    control_median_multiple NUMERIC,
    variant_median_multiple NUMERIC,
    median_multiple_lift NUMERIC,
    control_severe_loss_rate NUMERIC,
    variant_severe_loss_rate NUMERIC,
    bootstrap JSONB NOT NULL DEFAULT '{}'::jsonb,
    PRIMARY KEY(policy_fingerprint,variant_policy_id)
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS post_exit_shadows_v2 (
    id BIGSERIAL PRIMARY KEY,
    parent_trade_id BIGINT NOT NULL REFERENCES paper_trades(id) ON DELETE CASCADE,
    ca TEXT NOT NULL,
    symbol TEXT,
    policy_fingerprint TEXT NOT NULL,
    exit_at TIMESTAMPTZ NOT NULL,
    original_entry_price NUMERIC NOT NULL,
    exit_price NUMERIC NOT NULL,
    peak_price NUMERIC NOT NULL,
    trough_price NUMERIC NOT NULL,
    last_price NUMERIC NOT NULL,
    last_at TIMESTAMPTZ NOT NULL,
    state TEXT NOT NULL DEFAULT 'open',
    closed_at TIMESTAMPTZ,
    observation_source TEXT NOT NULL DEFAULT 'runtime_mark',
    UNIQUE(parent_trade_id,policy_fingerprint)
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS runner_shadow_variants (
    id BIGSERIAL PRIMARY KEY,
    parent_trade_id BIGINT NOT NULL REFERENCES paper_trades(id) ON DELETE CASCADE,
    ca TEXT NOT NULL,
    symbol TEXT,
    policy_fingerprint TEXT NOT NULL,
    variant_id TEXT NOT NULL,
    started_at TIMESTAMPTZ NOT NULL,
    sold_fraction NUMERIC NOT NULL,
    runner_fraction NUMERIC NOT NULL,
    trail_pct NUMERIC NOT NULL,
    condition_met BOOLEAN NOT NULL DEFAULT TRUE,
    upfront_proceeds_usd NUMERIC NOT NULL,
    runner_token_amount_raw TEXT,
    peak_multiple NUMERIC NOT NULL DEFAULT 3,
    last_multiple NUMERIC NOT NULL DEFAULT 3,
    stop_multiple NUMERIC NOT NULL DEFAULT 3,
    state TEXT NOT NULL DEFAULT 'open',
    close_reason TEXT,
    closed_at TIMESTAMPTZ,
    exit_quote_status TEXT,
    runner_exit_proceeds_usd NUMERIC,
    total_proceeds_usd NUMERIC,
    total_multiple NUMERIC,
    evidence_class TEXT NOT NULL DEFAULT 'execution_parent_mark_runner',
    UNIQUE(parent_trade_id,policy_fingerprint,variant_id)
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS evidence_experiment_recommendations (
    id BIGSERIAL PRIMARY KEY,
    policy_fingerprint TEXT NOT NULL,
    generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    active BOOLEAN NOT NULL DEFAULT TRUE,
    source_layer TEXT NOT NULL,
    reason_code TEXT NOT NULL,
    total_samples INT NOT NULL,
    missed_3x INT NOT NULL,
    severe_losses INT NOT NULL,
    score NUMERIC NOT NULL,
    recommendation JSONB NOT NULL
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_evidence_recommendations_active
    ON evidence_experiment_recommendations(policy_fingerprint,active,generated_at DESC)`);
  diag.initialized = true;
}

async function syncPolicyEpoch() {
  if (!pool) return;
  const next = currentPolicy();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO evidence_policy_epochs
      (fingerprint,source_commit,model_version,strategy_version,payload)
      VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(fingerprint) DO NOTHING`, [
      next.fingerprint, sourceCommit(), MODEL_VERSION, STRATEGY_VERSION, JSON.stringify(next.payload),
    ]);
    const active = await client.query(`SELECT fingerprint FROM evidence_policy_active WHERE singleton=TRUE FOR UPDATE`);
    const previous = active.rows[0]?.fingerprint ? String(active.rows[0].fingerprint) : null;
    if (previous !== next.fingerprint) {
      if (previous) await client.query(`UPDATE evidence_policy_epochs SET ended_at=COALESCE(ended_at,now()) WHERE fingerprint=$1`, [previous]);
      await client.query(`INSERT INTO evidence_policy_events(previous_fingerprint,next_fingerprint,reason,payload)
        VALUES($1,$2,$3,$4::jsonb)`, [previous, next.fingerprint,
        previous ? 'strategy-relevant policy fingerprint changed' : 'initial evidence policy activation',
        JSON.stringify({ sourceCommit: sourceCommit(), schemaVersion: POLICY_SCHEMA_VERSION })]);
      await client.query(`INSERT INTO evidence_policy_active(singleton,fingerprint,updated_at)
        VALUES(TRUE,$1,now()) ON CONFLICT(singleton) DO UPDATE SET fingerprint=$1,updated_at=now()`, [next.fingerprint]);
      if (previous) diag.policyRotations++;
    }
    await client.query('COMMIT');
    currentFingerprint = next.fingerprint;
    diag.policyFingerprint = next.fingerprint;
    const epoch = await pool.query(`SELECT started_at FROM evidence_policy_epochs WHERE fingerprint=$1`, [next.fingerprint]);
    diag.policyEpochStartedAt = epoch.rows[0]?.started_at ? new Date(epoch.rows[0].started_at).toISOString() : null;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function metricsFromDecision(value: unknown): PairedMetrics {
  const metrics = asObject(value);
  return {
    evidenceReady: metrics.evidenceReady === true,
    persistenceReady: metrics.persistenceReady === true,
    burstCooled: metrics.burstCooled === true,
    tooLate: metrics.tooLate === true,
    sourceEligible: metrics.sourceEligible !== false,
    modelAllows: metrics.modelAllows !== false,
    state: metrics.state ? String(metrics.state) : null,
  };
}

async function openPairedPolicyEntries() {
  if (!pool || !currentFingerprint) return;
  const result = await pool.query(`WITH latest AS (
      SELECT DISTINCT ON (d.paper_trade_id)
        d.id,d.paper_trade_id,d.at,d.price_usd,d.metrics,d.decision,d.reason_code
      FROM strategy_decisions d
      JOIN paper_trades q ON q.id=d.paper_trade_id
      WHERE q.policy_fingerprint=$1 AND q.strategy_role='quality_observation' AND d.stage='entry'
      ORDER BY d.paper_trade_id,d.at DESC
    )
    SELECT q.id AS quality_trade_id,q.ca,q.symbol,q.model_version,l.id AS decision_id,
           l.at,l.price_usd,l.metrics,l.decision,l.reason_code
      FROM latest l JOIN paper_trades q ON q.id=l.paper_trade_id
     WHERE l.price_usd>0
     ORDER BY l.at DESC LIMIT 300`, [currentFingerprint]);
  for (const row of result.rows) {
    const metrics = metricsFromDecision(row.metrics);
    for (const policyId of PAIRED_POLICIES) {
      if (!evaluatePairedVariant(policyId, metrics)) continue;
      const inserted = await pool.query(`INSERT INTO paired_policy_observations
        (quality_trade_id,ca,symbol,model_version,policy_fingerprint,policy_id,entry_at,entry_price,
         peak_price,trough_price,last_price,last_at,source_decision_id,entry_metrics)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8,$8,$8,$7,$9,$10::jsonb)
        ON CONFLICT DO NOTHING RETURNING id`, [
        row.quality_trade_id, row.ca, row.symbol, row.model_version, currentFingerprint, policyId,
        row.at, row.price_usd, row.decision_id, JSON.stringify({ ...metrics, reasonCode: row.reason_code }),
      ]);
      if (inserted.rowCount) diag.pairedEntriesOpened++;
    }
  }
}

function runtimePrice(runtimeValue: unknown, runtimeAt: unknown): number | null {
  if (!runtimeAt) return null;
  const observedAt = new Date(runtimeAt).getTime();
  if (!Number.isFinite(observedAt) || Date.now() - observedAt > PRICE_FRESH_MS) return null;
  const runtime = asObject(runtimeValue);
  const price = Number(runtime.priceUsd);
  return Number.isFinite(price) && price > 0 ? price : null;
}

async function markPairedPolicyEntries() {
  if (!pool) return;
  const result = await pool.query(`SELECT p.*,t.runtime,t.runtime_at
    FROM paired_policy_observations p LEFT JOIN tokens t ON t.ca=p.ca
    WHERE p.state='open' ORDER BY p.entry_at LIMIT 500`);
  const target = Number((cfg() as any).paper.target_multiple) || 3;
  const stop = Number((cfg() as any).paper.stop_multiple) || 0.5;
  const maxHoldMs = (Number((cfg() as any).paper.max_hold_hours) || 24) * 3_600_000;
  for (const row of result.rows) {
    const price = runtimePrice(row.runtime, row.runtime_at);
    if (!price) continue;
    const entry = Number(row.entry_price);
    const peak = Math.max(Number(row.peak_price), price);
    const trough = Math.min(Number(row.trough_price), price);
    const multiple = price / entry;
    const ageMs = Date.now() - new Date(row.entry_at).getTime();
    const closeReason = multiple >= target ? 'target_3x'
      : multiple <= stop ? 'stop_50pct'
      : ageMs >= maxHoldMs ? 'max_hold_24h'
      : null;
    const updated = await pool.query(`UPDATE paired_policy_observations SET
      peak_price=$2,trough_price=$3,last_price=$4,last_at=now(),
      state=CASE WHEN $5::text IS NULL THEN state ELSE 'closed' END,
      close_reason=COALESCE($5,close_reason),closed_at=CASE WHEN $5::text IS NULL THEN closed_at ELSE now() END,
      exit_multiple=CASE WHEN $5::text IS NULL THEN exit_multiple ELSE $6 END,
      target_hit=target_hit OR $7,severe_loss=severe_loss OR $8
      WHERE id=$1 AND state='open' RETURNING state`, [
      row.id, peak, trough, price, closeReason, multiple, peak / entry >= target, trough / entry <= stop,
    ]);
    if (closeReason && updated.rowCount) diag.pairedEntriesClosed++;
  }
}

interface PairedResolvedRow {
  quality_trade_id: string;
  policy_id: string;
  exit_multiple: string | number;
  target_hit: boolean;
  severe_loss: boolean;
}

function seededRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function bootstrapPaired(control: PairedResolvedRow[], variant: PairedResolvedRow[]) {
  const byControl = new Map(control.map(row => [String(row.quality_trade_id), row]));
  const pairs = variant.map(row => ({ control: byControl.get(String(row.quality_trade_id)), variant: row }))
    .filter((pair): pair is { control: PairedResolvedRow; variant: PairedResolvedRow } => !!pair.control);
  if (!pairs.length) return { pairs: 0, targetLift95: null, meanMultipleLift95: null };
  const random = seededRandom(0x4d454d45);
  const targetLifts: number[] = [];
  const returnLifts: number[] = [];
  for (let run = 0; run < 600; run++) {
    let targetLift = 0;
    let returnLift = 0;
    for (let index = 0; index < pairs.length; index++) {
      const pair = pairs[Math.floor(random() * pairs.length)];
      targetLift += Number(pair.variant.target_hit) - Number(pair.control.target_hit);
      returnLift += Number(pair.variant.exit_multiple) - Number(pair.control.exit_multiple);
    }
    targetLifts.push(targetLift / pairs.length);
    returnLifts.push(returnLift / pairs.length);
  }
  targetLifts.sort((a, b) => a - b);
  returnLifts.sort((a, b) => a - b);
  const interval = (values: number[]) => [values[Math.floor(values.length * 0.025)], values[Math.floor(values.length * 0.975)]];
  return { pairs: pairs.length, targetLift95: interval(targetLifts), meanMultipleLift95: interval(returnLifts) };
}

export function summarizePairedOutcomes(control: PairedResolvedRow[], variant: PairedResolvedRow[]) {
  const controlById = new Map(control.map(row => [String(row.quality_trade_id), row]));
  const pairedVariant = variant.filter(row => controlById.has(String(row.quality_trade_id)));
  const pairedControl = pairedVariant.map(row => controlById.get(String(row.quality_trade_id))!);
  const rate = (rows: PairedResolvedRow[], key: 'target_hit' | 'severe_loss') => rows.length
    ? rows.filter(row => row[key]).length / rows.length : null;
  const multiples = (rows: PairedResolvedRow[]) => rows.map(row => Number(row.exit_multiple)).filter(Number.isFinite);
  const controlTarget = rate(pairedControl, 'target_hit');
  const variantTarget = rate(pairedVariant, 'target_hit');
  const controlMedian = median(multiples(pairedControl));
  const variantMedian = median(multiples(pairedVariant));
  return {
    pairedResolved: pairedVariant.length,
    controlTargetRate: controlTarget,
    variantTargetRate: variantTarget,
    targetRateLift: controlTarget === null || variantTarget === null ? null : variantTarget - controlTarget,
    controlMedianMultiple: controlMedian,
    variantMedianMultiple: variantMedian,
    medianMultipleLift: controlMedian === null || variantMedian === null ? null : variantMedian - controlMedian,
    controlSevereLossRate: rate(pairedControl, 'severe_loss'),
    variantSevereLossRate: rate(pairedVariant, 'severe_loss'),
    bootstrap: bootstrapPaired(pairedControl, pairedVariant),
  };
}

async function assessPairedPolicies() {
  if (!pool || !currentFingerprint) return;
  const result = await pool.query(`SELECT quality_trade_id,policy_id,exit_multiple,target_hit,severe_loss
    FROM paired_policy_observations WHERE policy_fingerprint=$1 AND state='closed' AND exit_multiple IS NOT NULL`, [currentFingerprint]);
  const rows = result.rows as PairedResolvedRow[];
  const control = rows.filter(row => row.policy_id === 'control_current');
  for (const policyId of PAIRED_POLICIES.filter(value => value !== 'control_current')) {
    const summary = summarizePairedOutcomes(control, rows.filter(row => row.policy_id === policyId));
    await pool.query(`INSERT INTO paired_policy_assessments
      (policy_fingerprint,variant_policy_id,evaluated_at,paired_resolved,control_target_rate,variant_target_rate,
       target_rate_lift,control_median_multiple,variant_median_multiple,median_multiple_lift,
       control_severe_loss_rate,variant_severe_loss_rate,bootstrap)
      VALUES($1,$2,now(),$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
      ON CONFLICT(policy_fingerprint,variant_policy_id) DO UPDATE SET
       evaluated_at=now(),paired_resolved=$3,control_target_rate=$4,variant_target_rate=$5,target_rate_lift=$6,
       control_median_multiple=$7,variant_median_multiple=$8,median_multiple_lift=$9,
       control_severe_loss_rate=$10,variant_severe_loss_rate=$11,bootstrap=$12::jsonb`, [
      currentFingerprint, policyId, summary.pairedResolved, summary.controlTargetRate, summary.variantTargetRate,
      summary.targetRateLift, summary.controlMedianMultiple, summary.variantMedianMultiple,
      summary.medianMultipleLift, summary.controlSevereLossRate, summary.variantSevereLossRate,
      JSON.stringify(summary.bootstrap),
    ]);
  }
}

async function openPerExitShadows() {
  if (!pool) return;
  const inserted = await pool.query(`INSERT INTO post_exit_shadows_v2
    (parent_trade_id,ca,symbol,policy_fingerprint,exit_at,original_entry_price,exit_price,
     peak_price,trough_price,last_price,last_at)
    SELECT p.id,p.ca,p.symbol,p.policy_fingerprint,p.exit_at,p.entry_price,p.exit_price,
           p.exit_price,p.exit_price,p.exit_price,p.exit_at
      FROM paper_trades p
     WHERE p.strategy_role='timed_entry' AND p.closed=true AND p.exit_at IS NOT NULL
       AND p.exit_price>0 AND p.policy_fingerprint IS NOT NULL
    ON CONFLICT DO NOTHING RETURNING id`);
  diag.perExitShadowsOpened += inserted.rowCount || 0;
}

async function markPerExitShadows() {
  if (!pool) return;
  const result = await pool.query(`SELECT s.*,t.runtime,t.runtime_at
    FROM post_exit_shadows_v2 s LEFT JOIN tokens t ON t.ca=s.ca
    WHERE s.state='open' ORDER BY s.exit_at LIMIT 500`);
  for (const row of result.rows) {
    const price = runtimePrice(row.runtime, row.runtime_at);
    if (!price) continue;
    const peak = Math.max(Number(row.peak_price), price);
    const trough = Math.min(Number(row.trough_price), price);
    const agedOut = Date.now() - new Date(row.exit_at).getTime() >= SHADOW_MAX_AGE_MS;
    await pool.query(`UPDATE post_exit_shadows_v2 SET peak_price=$2,trough_price=$3,last_price=$4,last_at=now(),
      state=CASE WHEN $5 THEN 'closed' ELSE state END,closed_at=CASE WHEN $5 THEN now() ELSE closed_at END
      WHERE id=$1 AND state='open'`, [row.id, peak, trough, price, agedOut]);
  }
}

function runnerRawAmount(totalRaw: unknown, fraction: number): string | null {
  const value = String(totalRaw || '');
  if (!/^\d+$/.test(value) || fraction <= 0) return null;
  const millionths = BigInt(Math.round(fraction * 1_000_000));
  return ((BigInt(value) * millionths) / 1_000_000n).toString();
}

async function openRunnerVariants() {
  if (!pool) return;
  const parents = await pool.query(`SELECT id,ca,symbol,policy_fingerprint,exit_at,entry_price,position_usd,
      quoted_out_amount,exit_quoted_usd,exit_decision,exit_simulation_ok
    FROM paper_trades
    WHERE strategy_role='timed_entry' AND closed=true AND exit_reason='target_3x_exit_simulated'
      AND exit_at IS NOT NULL AND position_usd>0 AND exit_quoted_usd>0
      AND quoted_out_amount IS NOT NULL AND exit_simulation_ok=true AND policy_fingerprint IS NOT NULL
    ORDER BY exit_at DESC LIMIT 300`);
  for (const parent of parents.rows) {
    const exitDecision = asObject(parent.exit_decision);
    const metrics = asObject(exitDecision.metrics);
    const conditionStrong = Number(metrics.independentDeteriorationFamilyCount || 0) === 0;
    for (const variant of RUNNER_VARIANTS) {
      const conditionalRejected = variant.id === 'conditional_50_50' && !conditionStrong;
      const soldFraction = conditionalRejected ? 1 : variant.soldFraction;
      const runnerFraction = conditionalRejected ? 0 : variant.runnerFraction;
      const upfront = Number(parent.exit_quoted_usd) * soldFraction;
      const runnerRaw = runnerRawAmount(parent.quoted_out_amount, runnerFraction);
      const closedControl = runnerFraction === 0;
      const inserted = await pool.query(`INSERT INTO runner_shadow_variants
        (parent_trade_id,ca,symbol,policy_fingerprint,variant_id,started_at,sold_fraction,runner_fraction,
         trail_pct,condition_met,upfront_proceeds_usd,runner_token_amount_raw,state,close_reason,closed_at,
         total_proceeds_usd,total_multiple,evidence_class)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
          CASE WHEN $13 THEN 'closed' ELSE 'open' END,
          CASE WHEN $13 THEN $14 ELSE NULL END,
          CASE WHEN $13 THEN $6 ELSE NULL END,
          CASE WHEN $13 THEN $11 ELSE NULL END,
          CASE WHEN $13 THEN $11/NULLIF($15,0) ELSE NULL END,
          CASE WHEN $13 THEN 'execution_verified_full_exit' ELSE 'execution_parent_mark_runner_pending_quote' END)
        ON CONFLICT DO NOTHING RETURNING id`, [
        parent.id, parent.ca, parent.symbol, parent.policy_fingerprint, variant.id, parent.exit_at,
        soldFraction, runnerFraction, variant.trailPct, !conditionalRejected, upfront, runnerRaw,
        closedControl, conditionalRejected ? 'conditional_filter_rejected_runner' : 'full_exit_control', parent.position_usd,
      ]);
      if (inserted.rowCount) diag.runnerVariantsOpened++;
    }
  }
}

async function markRunnerVariants() {
  if (!pool) return;
  const result = await pool.query(`SELECT r.*,p.entry_price,p.position_usd,t.runtime,t.runtime_at
    FROM runner_shadow_variants r
    JOIN paper_trades p ON p.id=r.parent_trade_id
    LEFT JOIN tokens t ON t.ca=r.ca
    WHERE r.state='open' ORDER BY r.started_at LIMIT 200`);
  const quoteQueue: any[] = [];
  for (const row of result.rows) {
    const price = runtimePrice(row.runtime, row.runtime_at);
    if (!price) continue;
    const multiple = price / Number(row.entry_price);
    const peak = Math.max(Number(row.peak_multiple), multiple);
    const stop = runnerStopMultiple(peak, Number(row.trail_pct));
    const ageMs = Date.now() - new Date(row.started_at).getTime();
    const shouldExit = (peak > 3.02 && multiple <= stop) || ageMs >= SHADOW_MAX_AGE_MS;
    await pool.query(`UPDATE runner_shadow_variants SET peak_multiple=$2,last_multiple=$3,stop_multiple=$4
      WHERE id=$1 AND state='open'`, [row.id, peak, multiple, stop]);
    if (shouldExit && row.runner_token_amount_raw && quoteQueue.length < 3) quoteQueue.push({ ...row, multiple, peak, stop, ageMs });
  }

  for (const row of quoteQueue) {
    const quote = await quoteExecutableExit(String(row.ca), String(row.runner_token_amount_raw));
    if (quote.eligible && quote.proceedsUsd && quote.proceedsUsd > 0) {
      const total = Number(row.upfront_proceeds_usd) + quote.proceedsUsd;
      const totalMultiple = total / Number(row.position_usd);
      const reason = row.ageMs >= SHADOW_MAX_AGE_MS ? 'runner_max_hold_exit_simulated' : 'runner_trailing_exit_simulated';
      const updated = await pool.query(`UPDATE runner_shadow_variants SET
        state='closed',closed_at=now(),close_reason=$2,exit_quote_status=$3,
        runner_exit_proceeds_usd=$4,total_proceeds_usd=$5,total_multiple=$6,
        evidence_class='execution_verified_runner_exit'
        WHERE id=$1 AND state='open' RETURNING id`, [row.id, reason, quote.status, quote.proceedsUsd, total, totalMultiple]);
      if (updated.rowCount) diag.runnerVariantsClosed++;
    } else {
      await pool.query(`UPDATE runner_shadow_variants SET exit_quote_status=$2,
        evidence_class='runner_exit_quote_attempted_inconclusive'
        WHERE id=$1 AND state='open'`, [row.id, quote.status]);
    }
  }
}

async function experimentCandidates(): Promise<ExperimentCandidate[]> {
  if (!pool || !currentFingerprint) return [];
  const entry = await pool.query(`WITH candidates AS (
      SELECT q.id,q.entry_price,q.peak_price,q.trough_price,
        COALESCE(blocked.reason_code,'no_block_recorded_before_peak') AS reason_code
      FROM paper_trades q
      LEFT JOIN LATERAL (
        SELECT s.reason_code FROM signal_decisions s
        WHERE s.ca=q.ca AND s.allow=false AND s.evaluated_at<=COALESCE(q.peak_at,now())
        ORDER BY s.evaluated_at DESC LIMIT 1
      ) blocked ON true
      WHERE q.policy_fingerprint=$1 AND q.strategy_role='quality_observation'
        AND q.signal IS DISTINCT FROM 'post_exit_watch' AND q.entry_price>0
        AND NOT EXISTS (SELECT 1 FROM paper_trades p
          WHERE p.ca=q.ca AND p.model_version=q.model_version AND p.strategy_role='timed_entry'
            AND p.entry_at>=q.entry_at)
    )
    SELECT reason_code,COUNT(*)::int AS total,
      COUNT(*) FILTER(WHERE peak_price>=3*entry_price)::int AS missed_3x,
      COUNT(*) FILTER(WHERE trough_price<=0.5*entry_price)::int AS severe_losses
    FROM candidates GROUP BY reason_code`, [currentFingerprint]);

  const gate = await pool.query(`WITH per_token AS (
      SELECT t.ca,COALESCE(t.gate_fail_reason,'unknown_gate_reason') AS reason_code,
        MAX(o.multiple_from_first) AS peak_multiple,MIN(o.multiple_from_first) AS trough_multiple
      FROM tokens t JOIN outcomes o ON o.ca=t.ca
      WHERE t.gate_result IN ('kill','failed')
        AND t.first_seen>=COALESCE((SELECT started_at FROM evidence_policy_epochs WHERE fingerprint=$1),now())
        AND NOT EXISTS(SELECT 1 FROM paper_trades p WHERE p.ca=t.ca)
      GROUP BY t.ca,t.gate_fail_reason
    )
    SELECT reason_code,COUNT(*)::int AS total,
      COUNT(*) FILTER(WHERE peak_multiple>=3)::int AS missed_3x,
      COUNT(*) FILTER(WHERE trough_multiple<=0.5)::int AS severe_losses
    FROM per_token GROUP BY reason_code`, [currentFingerprint]);

  return [
    ...entry.rows.map(row => ({ sourceLayer: 'entry' as const, reasonCode: String(row.reason_code), total: Number(row.total), missed3x: Number(row.missed_3x), severeLosses: Number(row.severe_losses) })),
    ...gate.rows.map(row => ({ sourceLayer: 'gate' as const, reasonCode: String(row.reason_code), total: Number(row.total), missed3x: Number(row.missed_3x), severeLosses: Number(row.severe_losses) })),
  ];
}

async function generateExperimentRecommendation() {
  if (!pool || !currentFingerprint) return;
  const ranked = rankExperimentCandidates(await experimentCandidates());
  await pool.query(`UPDATE evidence_experiment_recommendations SET active=false
    WHERE policy_fingerprint=$1 AND active=true`, [currentFingerprint]);
  const best = ranked[0];
  if (!best || best.score <= 0) return;
  const recommendation = {
    action: 'launch_shadow_variant_only',
    changeCount: 1,
    sourceLayer: best.sourceLayer,
    reasonCode: best.reasonCode,
    proposedExperiment: best.sourceLayer === 'gate'
      ? `Create a counterfactual admission lane that relaxes only gate reason ${best.reasonCode}.`
      : `Create a counterfactual timed-entry lane that relaxes only block reason ${best.reasonCode}.`,
    safeguards: [
      'No production threshold change.',
      'Use the same opportunity stream and decision-time entry price.',
      'Require at least 30 paired resolutions before review.',
      'Reject the change if severe-loss rate rises by more than 2 percentage points.',
    ],
    evidence: best,
  };
  await pool.query(`INSERT INTO evidence_experiment_recommendations
    (policy_fingerprint,source_layer,reason_code,total_samples,missed_3x,severe_losses,score,recommendation)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`, [
    currentFingerprint, best.sourceLayer, best.reasonCode, best.total, best.missed3x,
    best.severeLosses, best.score, JSON.stringify(recommendation),
  ]);
  diag.recommendationsWritten++;
}

async function publishReadOnlySnapshot() {
  if (!pool) return;
  const [active, assessments, recommendation, runner] = await Promise.all([
    pool.query(`SELECT fingerprint,started_at,source_commit,model_version,strategy_version,payload
      FROM evidence_policy_epochs WHERE fingerprint=$1`, [currentFingerprint]),
    pool.query(`SELECT * FROM paired_policy_assessments WHERE policy_fingerprint=$1 ORDER BY variant_policy_id`, [currentFingerprint]),
    pool.query(`SELECT * FROM evidence_experiment_recommendations
      WHERE policy_fingerprint=$1 AND active=true ORDER BY generated_at DESC LIMIT 1`, [currentFingerprint]),
    pool.query(`SELECT variant_id,COUNT(*)::int AS samples,
      COUNT(*) FILTER(WHERE state='closed' AND evidence_class='execution_verified_runner_exit')::int AS verified,
      ROUND(AVG(total_multiple) FILTER(WHERE total_multiple IS NOT NULL)::numeric,3) AS avg_total_multiple
      FROM runner_shadow_variants WHERE policy_fingerprint=$1 GROUP BY variant_id ORDER BY variant_id`, [currentFingerprint]),
  ]);
  const snapshot = {
    generatedAt: new Date().toISOString(),
    evidenceSystem: POLICY_SCHEMA_VERSION,
    shadowOnly: true,
    signsOrBroadcastsTransactions: false,
    diagnostics: evidenceSystemV3Diag(),
    activePolicy: active.rows[0] || null,
    pairedPolicyAssessments: assessments.rows,
    activeExperimentRecommendation: recommendation.rows[0] || null,
    runnerExperiments: runner.rows,
    interpretation: {
      pairedPolicies: 'Counterfactual entries begin at each variant own decision-time price and are marked forward from that point.',
      runnerVariants: 'Only rows labeled execution_verified_runner_exit have an unsigned executable exit quote; mark-only rows are inconclusive.',
      recommendations: 'Recommendations create one shadow experiment and never modify production thresholds automatically.',
    },
  };
  const directory = path.join(process.cwd(), 'public');
  fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, 'evidence-system-v3.json');
  const temporary = `${target}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(snapshot, null, 2));
  fs.renameSync(temporary, target);
}

async function tick() {
  if (!pool || running) return;
  running = true;
  diag.lastTickAt = new Date().toISOString();
  try {
    await syncPolicyEpoch();
    await openPairedPolicyEntries();
    await markPairedPolicyEntries();
    await openPerExitShadows();
    await markPerExitShadows();
    await openRunnerVariants();
    await markRunnerVariants();
    const now = Date.now();
    if (now - lastAssessmentAt >= ASSESSMENT_EVERY_MS) {
      await assessPairedPolicies();
      lastAssessmentAt = now;
    }
    if (now - lastExperimentAt >= EXPERIMENT_EVERY_MS) {
      await generateExperimentRecommendation();
      lastExperimentAt = now;
    }
    await publishReadOnlySnapshot();
    diag.lastSuccessAt = new Date().toISOString();
    diag.lastError = null;
  } catch (error) {
    diag.lastError = (error as Error).message;
    console.error('[evidence-v3]', diag.lastError);
  } finally {
    running = false;
  }
}

export async function initializeEvidenceSystemV3() {
  if (!pool) return;
  await ensureSchema();
  await syncPolicyEpoch();
  await publishReadOnlySnapshot();
  console.log(`[evidence-v3] active policy ${currentFingerprint?.slice(0, 12) || 'unknown'}`);
}

export function startEvidenceSystemV3() {
  if (!pool || started) return;
  started = true;
  tick().catch(() => {});
  const timer = setInterval(() => tick().catch(() => {}), TICK_MS);
  timer.unref();
}
