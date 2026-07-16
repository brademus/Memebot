import crypto from 'crypto';
import { cfg } from '../config';
import { pool } from '../db';
import { activeTokens } from '../store';
import { quoteExecutableEntry } from '../paper/execution';
import { CompetingRiskHazards, ExecutionEvidence, MarketRegime, SignalDecision, SignalFeatureVector, TokenRecord } from '../types';
import { analyzeEntityGraph } from './entity-graph';
import { openPaper } from '../paper/paper';
import { buildSignalFeatures, flowEvidenceReady, graphEvidenceReady } from './features';
import { clamp01, round, softmax, standardDeviation } from './math';
import { learnedRankScore } from './rank-learner';
import { startPromotionGate, promotionReady, promotionStatus } from './promotion';
import { currentRegime } from './regime';
import { DECISION_MAX_AGE_MS, MODEL_VERSION, recommendationEligibleSource } from './version';

interface CalibrationBin { observations: number; posterior: number }
interface DecisionReasonGroups { core: string[]; readiness: string[] }
const FEEDER_REVISION = 'aggregate-flow-r2';
const calibration = new Map<string, CalibrationBin>();
const inFlight = new Map<string, Promise<SignalDecision | null>>();
const diag = {
  evaluated: 0, shadowCandidates: 0, executionReady: 0, allowed: 0, abstained: 0, executionProbes: 0,
  lastEvaluation: null as string | null, lastCalibration: null as string | null,
  lastError: null as string | null, reasons: {} as Record<string, number>,
};
export const ensembleDiag = () => ({
  ...diag,
  feederRevision: FEEDER_REVISION,
  inFlight: inFlight.size,
  calibrationBins: calibration.size,
  promotion: promotionStatus(),
});

export function startSignalEnsemble() {
  startPromotionGate();
  refreshCalibration().catch(() => {});
  const timer = setInterval(() => refreshCalibration().catch(() => {}), 15 * 60_000);
  timer.unref();
}

export function decisionAllowsRecommendation(token: TokenRecord, now = Date.now()): boolean {
  if (!cfg().signal_model.enabled) return recommendationEligibleSource(token.source);
  // Shadow mode never vetoes incumbent lanes. Even if configuration is switched to
  // enforce, the incumbent board remains live until the cached promotion gate proves
  // the model on executable holdout evidence and placebo-tested evaluations.
  if (cfg().signal_model.mode !== 'enforce' || !promotionReady())
    return recommendationEligibleSource(token.source);
  const decision = token.modelDecision;
  if (!decision || token.modelDecisionAt === null) return false;
  return decision.modelVersion === MODEL_VERSION && decision.allow && decision.expiresAt >= now
    && now - decision.evaluatedAt <= Math.max(DECISION_MAX_AGE_MS, cfg().signal_model.decision_ttl_seconds * 1000);
}

export async function refreshSignalDecision(token: TokenRecord, force = false): Promise<SignalDecision | null> {
  if (!cfg().signal_model.enabled || token.gated !== true || token.state === 'DEAD' || token.priceUsd <= 0) return null;
  if (token.score < Math.max(25, cfg().states.heating_score_min - 8)) return null;
  const now = Date.now();
  if (!force && token.modelDecision && token.modelDecision.expiresAt > now) return token.modelDecision;
  const existing = inFlight.get(token.ca);
  if (existing) return existing;
  const work = evaluate(token, now).finally(() => inFlight.delete(token.ca));
  inFlight.set(token.ca, work);
  return work;
}

async function evaluate(token: TokenRecord, now: number): Promise<SignalDecision> {
  if ((!token.entityGraph || !token.entityGraph.complete) && token.score >= cfg().states.heating_score_min)
    await analyzeEntityGraph(token).catch(() => null);
  const regime = currentRegime();
  const features = buildSignalFeatures(token, regime, now);
  const cohort = cohortRank(token, features, regime, now);
  const hazards = competingRiskHazards(features, regime);
  const rawTargetProbability = clamp01(hazards.target_2x + hazards.target_3x);
  const calibrated = calibrateProbability(rawTargetProbability, regime.kind);
  const targetBeforeStopProbability = calibrated.probability;
  const downsideProbability = clamp01(hazards.stop_30pct + hazards.stop_50pct + hazards.rug + hazards.route_loss);
  const expectedValue = expectedUtility(hazards, targetBeforeStopProbability, rawTargetProbability);
  const layerScores = [
    targetBeforeStopProbability, 1 - downsideProbability, features.buyerIndependence,
    1 - features.graphRisk, features.burstQuality, 1 - features.burstExhaustion,
    cohort.percentile, features.routePrior,
  ];
  const uncertainty = clamp01(
    0.30 * (1 - features.featureCompleteness)
    + 0.17 * (1 - Math.min(1, cohort.size / Math.max(1, cfg().signal_model.min_cohort_size * 2)))
    + 0.16 * (regime.kind === 'transition' ? 1 : regime.changeProbability)
    + 0.13 * (graphEvidenceReady(token) ? 0 : 1)
    + 0.12 * (1 - calibrated.confidence)
    + 0.12 * clamp01(standardDeviation(layerScores) / 0.35),
  );
  const grouped = decisionReasons(token, features, regime, cohort.percentile, cohort.size,
    targetBeforeStopProbability, downsideProbability, expectedValue, uncertainty, now);
  const preliminaryPass = grouped.core.length === 0;
  const executionReady = preliminaryPass && grouped.readiness.length === 0;
  const reasons = [...grouped.core, ...grouped.readiness];
  if (preliminaryPass) diag.shadowCandidates++;
  if (executionReady) diag.executionReady++;

  let execution: ExecutionEvidence | null = null;
  if (executionReady) {
    const quote = await quoteExecutableEntry(token, token.priceUsd);
    diag.executionProbes++;
    execution = {
      eligible: quote.eligible, status: quote.status, transactionBuilt: quote.transactionBuilt,
      simulationOk: quote.simulationOk, simulationError: quote.simulationError,
      executionScore: quote.executionScore, routeStabilityBps: quote.routeStabilityBps,
      requestedPositionSol: quote.requestedPositionSol, selectedRouter: quote.selectedRouter,
      selectedMode: quote.selectedMode, priceImpact: quote.priceImpact,
      unitsConsumed: quote.unitsConsumed, probeSizes: quote.probeSizes,
    };
    if (!execution.eligible) reasons.push(`execution:${execution.status}`);
    if (execution.executionScore < cfg().signal_model.min_execution_score)
      reasons.push(`execution_score:${execution.executionScore.toFixed(2)}`);
    await persistExecutionProbe(token, execution).catch(error =>
      console.error('[signal-ensemble] execution probe persist', (error as Error).message));
  }
  const allow = executionReady && !!execution?.eligible && reasons.length === 0;
  const decision: SignalDecision = {
    modelVersion: MODEL_VERSION, evaluatedAt: now,
    expiresAt: now + cfg().signal_model.decision_ttl_seconds * 1000,
    allow, preliminaryPass, reasons, regime, features, hazards,
    targetBeforeStopProbability: round(targetBeforeStopProbability),
    downsideProbability: round(downsideProbability), expectedValue: round(expectedValue),
    uncertainty: round(uncertainty), alphaScore: round(cohort.alpha),
    cohortPercentile: round(cohort.percentile), cohortSize: cohort.size, execution,
  };
  token.modelDecision = decision;
  token.modelDecisionAt = now;
  diag.evaluated++;
  diag.lastEvaluation = new Date(now).toISOString();
  diag.lastError = null;
  if (allow) diag.allowed++; else diag.abstained++;
  for (const reason of reasons.length ? reasons : ['allowed'])
    diag.reasons[reason.split(':')[0]] = (diag.reasons[reason.split(':')[0]] || 0) + 1;

  await persistDecision(token, decision).catch(error => {
    diag.lastError = (error as Error).message;
    console.error('[signal-ensemble] persist', diag.lastError);
  });

  // Raw shadow evidence measures the cross-sectional/survival candidate before data
  // availability and execution readiness. Executable evidence remains fail-closed and
  // requires measured graph/flow inputs plus a built and simulated Jupiter route.
  if (preliminaryPass && token.priceUsd > 0) {
    await openPaper(token.ca, token.symbol, 'model_raw', token.priceUsd, token.score, undefined, { skipExecutionQuote: true })
      .catch(error => console.error('[model-paper:raw]', (error as Error).message));
  }
  if (allow && token.priceUsd > 0) {
    await openPaper(token.ca, token.symbol, 'model_executable', token.priceUsd, token.score, execution || undefined)
      .catch(error => console.error('[model-paper:executable]', (error as Error).message));
  }
  return decision;
}

export function competingRiskHazards(features: SignalFeatureVector, regime: MarketRegime): CompetingRiskHazards {
  const regimeLift = regime.kind === 'mania' ? 0.28 : regime.kind === 'hot' ? 0.16
    : regime.kind === 'cold' ? -0.16 : regime.kind === 'adverse' ? -0.42 : regime.kind === 'transition' ? -0.25 : 0;
  const quality =
    1.15 * features.capitalEfficiency + 0.95 * features.curveSpeed1m + 0.55 * features.curveSpeed3m
    + 0.85 * features.organicBreadth + 0.58 * features.buyPressure + 0.52 * features.smartMoney
    + 0.45 * features.socialCredibility + 0.50 * features.buyerIndependence
    + 0.55 * features.burstQuality + 0.35 * features.flowRetention + 0.28 * features.tradeAcceleration
    - 1.15 * features.graphRisk - 0.82 * features.burstExhaustion - 0.68 * features.runupPenalty
    - 0.54 * features.deployerRisk + 0.35 * features.routePrior + regimeLift;
  const raw = {
    target_1_5x: -0.35 + 0.72 * quality,
    target_2x: -1.28 + 0.82 * quality,
    target_3x: -2.45 + 0.92 * quality,
    stop_30pct: -0.25 - 0.55 * quality + 0.55 * features.burstExhaustion + 0.45 * features.runupPenalty,
    stop_50pct: -1.05 - 0.65 * quality + 0.55 * features.graphRisk + 0.45 * features.deployerRisk,
    rug: -2.0 - 0.35 * quality + 1.35 * features.graphRisk + 0.75 * features.deployerRisk,
    route_loss: -1.8 - 0.75 * features.routePrior + 0.55 * (1 - features.liquidityDepth),
    timeout: -0.15 - 0.15 * quality + 0.25 * (1 - features.tradeAcceleration),
  };
  const probabilities = softmax(raw);
  return Object.fromEntries(Object.entries(probabilities).map(([key, value]) => [key, round(value)])) as unknown as CompetingRiskHazards;
}

export function alphaScore(features: SignalFeatureVector, regime: MarketRegime): number {
  const regimePenalty = regime.kind === 'adverse' ? 0.22 : regime.kind === 'transition' ? 0.14 : regime.kind === 'cold' ? 0.06 : 0;
  const fixed = clamp01(
    0.16 * features.capitalEfficiency + 0.13 * features.curveSpeed1m + 0.08 * features.curveSpeed3m
    + 0.13 * features.organicBreadth + 0.08 * features.buyPressure + 0.07 * features.smartMoney
    + 0.06 * features.socialCredibility + 0.10 * features.buyerIndependence
    + 0.08 * features.burstQuality + 0.06 * features.flowRetention + 0.05 * features.routePrior
    - 0.14 * features.graphRisk - 0.10 * features.burstExhaustion - 0.08 * features.runupPenalty
    - regimePenalty + 0.18,
  );
  const learned = learnedRankScore(features);
  // The learned model contributes only after passing chronological validation and its
  // placebo gate. Keeping a majority fixed component limits sudden parameter drift.
  return learned === null ? fixed : clamp01(0.55 * fixed + 0.45 * learned);
}

function cohortRank(token: TokenRecord, features: SignalFeatureVector, regime: MarketRegime, now: number) {
  const targetAlpha = alphaScore(features, regime);
  const age = features.ageMinutes;
  const cohort = activeTokens().filter(candidate => recommendationEligibleSource(candidate.source)
    && candidate.priceUsd > 0
    && (candidate.dex === token.dex || (!!candidate.gradAt === !!token.gradAt))
    && Math.abs((now - candidate.firstSeen) / 60_000 - age) <= Math.max(2, age * 0.75));
  const scores = cohort.map(candidate => alphaScore(buildSignalFeatures(candidate, regime, now), regime));
  if (!scores.some(score => Math.abs(score - targetAlpha) < 1e-8)) scores.push(targetAlpha);
  const below = scores.filter(score => score < targetAlpha).length;
  const tied = scores.filter(score => Math.abs(score - targetAlpha) < 1e-8).length;
  const percentile = scores.length ? (below + 0.5 * tied) / scores.length : 0;
  return { alpha: targetAlpha, percentile: clamp01(percentile), size: scores.length };
}

function decisionReasons(
  token: TokenRecord, features: SignalFeatureVector, regime: MarketRegime, percentile: number, cohortSize: number,
  target: number, downside: number, expectedValue: number, uncertainty: number, now: number,
): DecisionReasonGroups {
  const model = cfg().signal_model;
  const core: string[] = [];
  const readiness: string[] = [];
  if (!recommendationEligibleSource(token.source) || features.sourceEligible < 1) core.push('source_quarantined');
  if (regime.kind === 'adverse') core.push('adverse_regime');
  if (regime.kind === 'transition' && regime.changeProbability >= model.regime_change_abstain_threshold) core.push('regime_transition');
  if (cohortSize < model.min_cohort_size) core.push(`cohort_small:${cohortSize}`);
  if (percentile < model.min_rank_percentile) core.push(`rank:${percentile.toFixed(2)}`);
  if (target < model.min_target_before_stop) core.push(`target_probability:${target.toFixed(3)}`);
  if (downside > model.max_downside_probability) core.push(`downside:${downside.toFixed(2)}`);
  if (expectedValue < model.min_expected_value) core.push(`expected_value:${expectedValue.toFixed(2)}`);

  if (features.featureCompleteness < model.min_feature_completeness) readiness.push(`incomplete_features:${features.featureCompleteness.toFixed(2)}`);
  if (!graphEvidenceReady(token)) readiness.push('graph_unavailable');
  else {
    if (features.graphRisk > model.max_graph_risk) readiness.push(`graph_risk:${features.graphRisk.toFixed(2)}`);
    if (features.buyerIndependence < model.min_independent_entity_ratio) readiness.push(`entity_independence:${features.buyerIndependence.toFixed(2)}`);
  }
  if (!flowEvidenceReady(token, now)) readiness.push('flow_unavailable');
  if (features.burstExhaustion > model.max_burst_exhaustion) readiness.push(`burst_exhaustion:${features.burstExhaustion.toFixed(2)}`);
  if (uncertainty > model.max_uncertainty) readiness.push(`uncertainty:${uncertainty.toFixed(2)}`);
  return { core, readiness };
}

function expectedUtility(hazards: CompetingRiskHazards, calibratedTarget: number, rawTarget: number): number {
  const targetScale = rawTarget > 0 ? calibratedTarget / rawTarget : 1;
  return hazards.target_1_5x * 0.5 + hazards.target_2x * targetScale + hazards.target_3x * targetScale * 2
    - hazards.stop_30pct * 0.30 - hazards.stop_50pct * 0.50 - hazards.rug * 0.95
    - hazards.route_loss * 0.55 - hazards.timeout * 0.08;
}

function calibrateProbability(raw: number, regimeKind: string) {
  const bin = Math.max(0, Math.min(9, Math.floor(clamp01(raw) * 10)));
  const exact = calibration.get(`${regimeKind}:${bin}`) || calibration.get(`all:${bin}`);
  if (!exact || exact.observations < 20) return { probability: raw, confidence: clamp01((exact?.observations || 0) / 20) };
  const weight = clamp01(exact.observations / 100);
  return { probability: clamp01(raw * (1 - weight) + exact.posterior * weight), confidence: weight };
}

async function refreshCalibration() {
  if (!pool) return;
  const rows = await pool.query(
    `SELECT regime_kind,probability_bin,observations,posterior_probability
       FROM model_calibration_bins WHERE model_version=$1`, [MODEL_VERSION],
  ).catch(() => ({ rows: [] as any[] }));
  calibration.clear();
  for (const row of rows.rows) calibration.set(`${row.regime_kind}:${row.probability_bin}`, {
    observations: Number(row.observations) || 0, posterior: Number(row.posterior_probability) || 0,
  });
  diag.lastCalibration = new Date().toISOString();
}

async function persistExecutionProbe(token: TokenRecord, execution: ExecutionEvidence) {
  if (!pool) return;
  await pool.query(
    `INSERT INTO execution_probes
       (ca,model_version,direction,input_amount,requested_sol,status,eligible,transaction_built,
        simulation_ok,simulation_error,units_consumed,router,mode,price_impact,route_stability_bps,
        execution_score,probes)
     VALUES ($1,$2,'entry',NULL,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [token.ca, MODEL_VERSION, execution.requestedPositionSol, execution.status, execution.eligible,
     execution.transactionBuilt, execution.simulationOk, execution.simulationError,
     execution.unitsConsumed, execution.selectedRouter, execution.selectedMode, execution.priceImpact,
     execution.routeStabilityBps, execution.executionScore, JSON.stringify(execution.probeSizes)],
  );
}

async function persistDecision(token: TokenRecord, decision: SignalDecision) {
  if (!pool) return;
  // Durable evidence is sampled once per five-minute state bucket. The live decision
  // still refreshes every 45 seconds, but the database does not grow by one row per TTL.
  const bucket = Math.floor(decision.evaluatedAt / 300_000);
  const hash = crypto.createHash('sha256').update(JSON.stringify({
    ca: token.ca, bucket, feeder: FEEDER_REVISION, regime: decision.regime.id,
    alpha: round(decision.alphaScore, 2), target: round(decision.targetBeforeStopProbability, 2),
    preliminary: decision.preliminaryPass, allow: decision.allow,
  })).digest('hex').slice(0, 24);
  const inserted = await pool.query(
    `INSERT INTO signal_decisions
       (ca,symbol,model_version,evaluated_at,expires_at,allow,preliminary_pass,reasons,regime_id,
        source,price_usd,base_score,alpha_score,cohort_percentile,cohort_size,
        target_before_stop_probability,downside_probability,expected_value,uncertainty,
        hazards,features,execution,decision_hash)
     VALUES ($1,$2,$3,to_timestamp($4/1000.0),to_timestamp($5/1000.0),$6,$7,$8::text[],$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
     ON CONFLICT (ca,model_version,decision_hash) DO NOTHING RETURNING id`,
    [token.ca, token.symbol, MODEL_VERSION, decision.evaluatedAt, decision.expiresAt, decision.allow,
     decision.preliminaryPass, decision.reasons, decision.regime.id, token.source, token.priceUsd,
     token.score, decision.alphaScore, decision.cohortPercentile, decision.cohortSize,
     decision.targetBeforeStopProbability, decision.downsideProbability, decision.expectedValue,
     decision.uncertainty, JSON.stringify(decision.hazards), JSON.stringify(decision.features),
     decision.execution ? JSON.stringify(decision.execution) : null, hash],
  );
  if (inserted.rows[0]?.id) await pool.query(
    `INSERT INTO signal_decision_outcomes (decision_id,entry_price,last_price,last_multiple,max_multiple,min_multiple)
     VALUES ($1,$2,$2,1,1,1) ON CONFLICT DO NOTHING`,
    [inserted.rows[0].id, token.priceUsd],
  );
}
