import { pool } from '../db';
import { ensembleDiag } from '../model/ensemble';
import { evaluationDiag } from '../model/evaluation';
import { observationDiag } from '../model/observations';
import { decisionOutcomeDiag } from '../model/outcomes';
import { regimeDiag } from '../model/regime';
import { modelRuntimeDiag } from '../model/runtime';
import { tradeEventDiag } from '../market/trade-events';
import { MODEL_VERSION } from '../model/version';

export async function buildSignalReport(days = 7) {
  const readiness = {
    modelVersion: MODEL_VERSION,
    jupiterKeyConfigured: !!process.env.JUPITER_API_KEY,
    simulationWalletConfigured: !!process.env.SIMULATION_WALLET,
    solanaRpcConfigured: !!(process.env.SOLANA_RPC_URL || process.env.HELIUS_API_KEY),
    privateKeyRequired: false,
    broadcastEnabled: false,
  };
  if (!pool) return { readiness, note: 'No database attached; v3 live decisions can run but durable evidence is unavailable.' };
  const bounded = Math.max(1, Math.min(90, days));
  const query = async (sql: string, parameters: unknown[] = []) => (await pool!.query(sql, parameters)).rows;

  const decisionFunnel = await query(
    `SELECT COUNT(*)::int AS evaluated,
            COUNT(*) FILTER (WHERE preliminary_pass)::int AS preliminary_pass,
            COUNT(*) FILTER (WHERE execution IS NOT NULL)::int AS execution_probed,
            COUNT(*) FILTER (WHERE allow)::int AS allowed,
            ROUND(AVG(target_before_stop_probability)::numeric,4) AS avg_target_probability,
            ROUND(AVG(downside_probability)::numeric,4) AS avg_downside_probability,
            ROUND(AVG(uncertainty)::numeric,4) AS avg_uncertainty
       FROM signal_decisions WHERE model_version=$1 AND evaluated_at>now()-($2||' days')::interval`,
    [MODEL_VERSION, String(bounded)],
  );
  const abstentionReasons = await query(
    `SELECT reason,COUNT(*)::int AS n FROM signal_decisions,CROSS JOIN LATERAL unnest(reasons) AS reason
      WHERE model_version=$1 AND evaluated_at>now()-($2||' days')::interval
      GROUP BY reason ORDER BY n DESC LIMIT 25`, [MODEL_VERSION, String(bounded)],
  );
  const firstEventPerformance = await query(
    `SELECT decision.allow,outcome.first_event,COUNT(*)::int AS n,
            ROUND(AVG(outcome.max_multiple)::numeric,3) AS avg_max_multiple,
            ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY outcome.max_multiple))::numeric,3) AS median_max_multiple,
            ROUND(AVG(outcome.min_multiple)::numeric,3) AS avg_min_multiple
       FROM signal_decisions decision JOIN signal_decision_outcomes outcome ON outcome.decision_id=decision.id
      WHERE decision.model_version=$1 AND outcome.status='resolved' AND NOT outcome.tracking_gap
        AND decision.evaluated_at>now()-($2||' days')::interval
      GROUP BY decision.allow,outcome.first_event ORDER BY decision.allow DESC,n DESC`, [MODEL_VERSION, String(bounded)],
  );
  const regimePerformance = await query(
    `SELECT split_part(decision.regime_id,':',2) AS regime,decision.allow,COUNT(*)::int AS n,
            ROUND(AVG(CASE WHEN outcome.first_event='target_2x' THEN 1.0 ELSE 0 END)::numeric,4) AS target_before_loss_rate,
            ROUND(AVG(outcome.max_multiple)::numeric,3) AS avg_max_multiple
       FROM signal_decisions decision JOIN signal_decision_outcomes outcome ON outcome.decision_id=decision.id
      WHERE decision.model_version=$1 AND outcome.status='resolved' AND NOT outcome.tracking_gap
        AND decision.evaluated_at>now()-($2||' days')::interval
      GROUP BY regime,decision.allow ORDER BY regime,decision.allow DESC`, [MODEL_VERSION, String(bounded)],
  );
  const graphCalibration = await query(
    `SELECT width_bucket((observation.entity_features->>'graphRisk')::float,0,1,5) AS risk_band,
            COUNT(*)::int AS n,
            ROUND(AVG(outcome.multiple)::numeric,3) AS avg_multiple_60m,
            ROUND((COUNT(*) FILTER (WHERE outcome.multiple>=2))::numeric/NULLIF(COUNT(*),0)*100,2) AS pct_2x
       FROM signal_observations observation JOIN signal_observation_outcomes outcome
         ON outcome.observation_id=observation.id AND outcome.horizon_minutes=60
      WHERE observation.model_version=$1 AND observation.entity_features IS NOT NULL AND outcome.status='resolved'
        AND observation.captured_at>now()-($2||' days')::interval
      GROUP BY risk_band ORDER BY risk_band`, [MODEL_VERSION, String(bounded)],
  );
  const burstCalibration = await query(
    `SELECT width_bucket((observation.burst_features->>'exhaustion')::float,0,1,5) AS exhaustion_band,
            COUNT(*)::int AS n,ROUND(AVG(outcome.multiple)::numeric,3) AS avg_multiple_60m,
            ROUND((COUNT(*) FILTER (WHERE outcome.multiple<0.7))::numeric/NULLIF(COUNT(*),0)*100,2) AS pct_down_30
       FROM signal_observations observation JOIN signal_observation_outcomes outcome
         ON outcome.observation_id=observation.id AND outcome.horizon_minutes=60
      WHERE observation.model_version=$1 AND outcome.status='resolved'
        AND observation.captured_at>now()-($2||' days')::interval
      GROUP BY exhaustion_band ORDER BY exhaustion_band`, [MODEL_VERSION, String(bounded)],
  );
  const rankCalibration = await query(
    `SELECT width_bucket(cohort_percentile,0,1,10) AS percentile_decile,COUNT(*)::int AS n,
            ROUND(AVG(CASE WHEN outcome.first_event='target_2x' THEN 1.0 ELSE 0 END)::numeric,4) AS target_before_loss_rate,
            ROUND(AVG(outcome.max_multiple)::numeric,3) AS avg_max_multiple
       FROM signal_decisions decision JOIN signal_decision_outcomes outcome ON outcome.decision_id=decision.id
      WHERE decision.model_version=$1 AND outcome.status='resolved' AND NOT outcome.tracking_gap
        AND decision.evaluated_at>now()-($2||' days')::interval
      GROUP BY percentile_decile ORDER BY percentile_decile`, [MODEL_VERSION, String(bounded)],
  );
  const executionPerformance = await query(
    `SELECT status,transaction_built,simulation_ok,router,mode,COUNT(*)::int AS n,
            ROUND(AVG(price_impact)::numeric,5) AS avg_price_impact,
            ROUND(AVG(route_stability_bps)::numeric,1) AS avg_route_stability_bps,
            ROUND(AVG(execution_score)::numeric,3) AS avg_execution_score
       FROM execution_probes WHERE model_version=$1 AND probed_at>now()-($2||' days')::interval
      GROUP BY status,transaction_built,simulation_ok,router,mode ORDER BY n DESC`, [MODEL_VERSION, String(bounded)],
  );
  const observationCoverage = await query(
    `SELECT observation_key,source,COUNT(*)::int AS captured,
            COUNT(*) FILTER (WHERE outcome.status='resolved')::int AS resolved_labels,
            COUNT(*) FILTER (WHERE outcome.status='unresolved')::int AS unresolved_labels
       FROM signal_observations observation LEFT JOIN signal_observation_outcomes outcome ON outcome.observation_id=observation.id
      WHERE observation.model_version=$1 AND observation.captured_at>now()-($2||' days')::interval
      GROUP BY observation_key,source ORDER BY observation_key,source`, [MODEL_VERSION, String(bounded)],
  );
  const evaluations = await query(
    `SELECT evaluated_at,train_rows,test_rows,metrics,regime_metrics,placebo_metrics,passed_falsification,notes
       FROM model_evaluations WHERE model_version=$1 ORDER BY evaluated_at DESC LIMIT 10`, [MODEL_VERSION],
  );

  return {
    readiness,
    runtime: modelRuntimeDiag(),
    layers: {
      regime: regimeDiag(),
      ensemble: ensembleDiag(),
      tradeSequence: tradeEventDiag(),
      observations: observationDiag(),
      decisionOutcomes: decisionOutcomeDiag(),
      evaluation: evaluationDiag(),
    },
    decisionFunnel: decisionFunnel[0] || {},
    abstentionReasons,
    firstEventPerformance,
    regimePerformance,
    graphCalibration,
    burstCalibration,
    rankCalibration,
    executionPerformance,
    observationCoverage,
    evaluations,
    interpretation: 'A production call requires fresh agreement across survival, cohort rank, temporal entity graph, event-time flow, regime, uncertainty and a built/simulated route. Evaluation is chronological and reports creator-isolated test rows plus shuffled-label and time-shift placebos.',
  };
}
