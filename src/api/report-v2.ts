import { pool } from '../db';
import { cfg } from '../config';
import { MODEL_VERSION } from '../model/version';
import { paperQuoteStatusBreakdown, paperScoreboard } from '../paper/paper';
import { scorecalDiag } from '../tuning/scorecal';
import { learningDiag } from '../tuning/filtertune';
import { forwardEvidenceDiag } from '../tuning/snapshots';

const RAW_COMPONENTS = ['freshness', 'velocity', 'buy_pressure', 'organic', 'social', 'smart_money'] as const;

export async function buildReport(days = 7): Promise<any> {
  if (!pool) return { note: 'no database attached — outcomes not being logged' };
  const boundedDays = Math.max(1, Math.min(days, 90));
  const q = async (sql: string, params: any[] = []) => (await pool!.query(sql, params)).rows;

  const totals = (await q(`SELECT COUNT(*) AS total_seen,
      COUNT(*) FILTER (WHERE gate_result='passed') AS passed,
      COUNT(*) FILTER (WHERE gate_result='failed') AS killed,
      COUNT(*) FILTER (WHERE triggered_at IS NOT NULL) AS triggered,
      COUNT(*) FILTER (WHERE conviction_at IS NOT NULL) AS convictions
    FROM tokens`))[0];

  const funnelHealth = await q(`SELECT COUNT(*) AS total_seen,
      COUNT(*) FILTER (WHERE gate_result='passed') AS passed_gates,
      COUNT(*) FILTER (WHERE gate_result='failed') AS killed_gates,
      COUNT(*) FILTER (WHERE triggered_at IS NOT NULL) AS triggered,
      COUNT(*) FILTER (WHERE conviction_at IS NOT NULL) AS conviction
    FROM tokens WHERE first_seen > now()-($1||' days')::interval`, [String(boundedDays)]);

  const sourcePerformance = await q(`SELECT t.source, COUNT(*) AS n,
      ROUND(AVG(o.multiple_from_first)::numeric,2) AS avg_multiple,
      ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY o.multiple_from_first))::numeric,2) AS median_multiple,
      ROUND((COUNT(*) FILTER (WHERE o.multiple_from_first>=2))::numeric/NULLIF(COUNT(*),0)*100,1) AS pct_2x_plus,
      MAX(o.multiple_from_first) AS best
    FROM tokens t JOIN outcomes o ON o.ca=t.ca AND o.snapshot_minutes=240
    WHERE t.gate_result='passed' AND t.first_seen > now()-($1||' days')::interval
    GROUP BY t.source ORDER BY pct_2x_plus DESC NULLS LAST`, [String(boundedDays)]);

  const gateKillReasons = await q(`SELECT gate_fail_reason AS reason, COUNT(*) AS n
    FROM tokens WHERE gate_result='failed' AND gate_fail_reason IS NOT NULL
      AND first_seen > now()-($1||' days')::interval
    GROUP BY gate_fail_reason ORDER BY n DESC LIMIT 20`, [String(boundedDays)]);

  const triggerPerformance = await q(`SELECT COALESCE(t.trigger_model_version,'legacy') AS model_version,
      o.snapshot_minutes AS mins, COUNT(*) AS n,
      ROUND(AVG(o.price_usd/NULLIF(t.trigger_price,0))::numeric,2) AS avg_multiple,
      ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY o.price_usd/NULLIF(t.trigger_price,0)))::numeric,2) AS median_multiple,
      ROUND((COUNT(*) FILTER (WHERE o.price_usd/NULLIF(t.trigger_price,0)>=2))::numeric/NULLIF(COUNT(*),0)*100,1) AS pct_2x_plus,
      ROUND((COUNT(*) FILTER (WHERE o.price_usd/NULLIF(t.trigger_price,0)<1))::numeric/NULLIF(COUNT(*),0)*100,1) AS pct_down
    FROM tokens t JOIN outcomes o ON o.ca=t.ca
    WHERE t.triggered_at IS NOT NULL AND t.trigger_price>0
      AND t.first_seen > now()-($1||' days')::interval
    GROUP BY model_version,o.snapshot_minutes ORDER BY model_version DESC,o.snapshot_minutes`, [String(boundedDays)]);

  const convictionPerformance = await q(`SELECT COALESCE(t.conviction_model_version,'legacy') AS model_version,
      o.snapshot_minutes AS mins, COUNT(*) AS n,
      ROUND(AVG(o.price_usd/NULLIF(t.conviction_price,0))::numeric,2) AS avg_multiple,
      ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY o.price_usd/NULLIF(t.conviction_price,0)))::numeric,2) AS median_multiple,
      ROUND((COUNT(*) FILTER (WHERE o.price_usd/NULLIF(t.conviction_price,0)>=2))::numeric/NULLIF(COUNT(*),0)*100,1) AS pct_2x_plus,
      ROUND((COUNT(*) FILTER (WHERE o.price_usd/NULLIF(t.conviction_price,0)<1))::numeric/NULLIF(COUNT(*),0)*100,1) AS pct_down
    FROM tokens t JOIN outcomes o ON o.ca=t.ca
    WHERE t.conviction_at IS NOT NULL AND t.conviction_price>0
      AND t.first_seen > now()-($1||' days')::interval
    GROUP BY model_version,o.snapshot_minutes ORDER BY model_version DESC,o.snapshot_minutes`, [String(boundedDays)]);

  const forwardSnapshotPerformance = await q(`SELECT snapshot_age_min, source,
      recommendation_eligible, COUNT(*) AS n,
      ROUND(AVG(forward_multiple)::numeric,3) AS avg_multiple,
      ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY forward_multiple))::numeric,3) AS median_multiple,
      ROUND((PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY forward_multiple))::numeric,3) AS p75_multiple,
      ROUND((PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY forward_multiple))::numeric,3) AS p90_multiple,
      ROUND((COUNT(*) FILTER (WHERE forward_multiple>=2))::numeric/NULLIF(COUNT(*),0)*100,1) AS pct_2x_plus,
      ROUND((COUNT(*) FILTER (WHERE forward_multiple<1))::numeric/NULLIF(COUNT(*),0)*100,1) AS pct_down,
      ROUND((COUNT(*) FILTER (WHERE forward_multiple<=0.5))::numeric/NULLIF(COUNT(*),0)*100,1) AS pct_down_50
    FROM score_snapshots
    WHERE model_version=$1 AND resolve_status='resolved'
      AND captured_at > now()-($2||' days')::interval
    GROUP BY snapshot_age_min,source,recommendation_eligible
    ORDER BY snapshot_age_min,source`, [MODEL_VERSION, String(boundedDays)]).catch(() => []);

  const scoreCalibration = await q(`SELECT width_bucket(score,0,100,5)*20 AS score_band_top,
      COUNT(*) AS n,
      ROUND(AVG(forward_multiple)::numeric,3) AS avg_forward_multiple,
      ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY forward_multiple))::numeric,3) AS median_forward_multiple,
      ROUND((COUNT(*) FILTER (WHERE forward_multiple>=2))::numeric/NULLIF(COUNT(*),0)*100,1) AS pct_2x_plus
    FROM score_snapshots
    WHERE model_version=$1 AND recommendation_eligible=true AND resolve_status='resolved'
      AND captured_at > now()-($2||' days')::interval
    GROUP BY score_band_top ORDER BY score_band_top`, [MODEL_VERSION, String(boundedDays)]).catch(() => []);

  const componentCalibration: Record<string, any[]> = {};
  for (const component of RAW_COMPONENTS) {
    componentCalibration[component] = await q(`WITH ranked AS (
        SELECT NTILE(3) OVER (ORDER BY (raw->>$3)::float) AS tercile,
               forward_multiple AS multiple
        FROM score_snapshots
        WHERE model_version=$1 AND recommendation_eligible=true
          AND resolve_status='resolved' AND raw ? $3
          AND captured_at > now()-($2||' days')::interval)
      SELECT tercile, COUNT(*) AS n,
        ROUND(AVG(multiple)::numeric,3) AS avg_multiple,
        ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY multiple))::numeric,3) AS median_multiple,
        ROUND((COUNT(*) FILTER (WHERE multiple>=2))::numeric/NULLIF(COUNT(*),0)*100,1) AS pct_2x_plus
      FROM ranked GROUP BY tercile ORDER BY tercile`, [MODEL_VERSION, String(boundedDays), component]).catch(() => []);
  }

  const falseKills = await q(`SELECT t.gate_fail_reason AS reason, COUNT(*) AS killed,
      COUNT(*) FILTER (WHERE o.multiple_from_first>=3) AS would_have_3x,
      ROUND((COUNT(*) FILTER (WHERE o.multiple_from_first>=3))::numeric/NULLIF(COUNT(*),0)*100,1) AS false_kill_pct,
      ROUND(MAX(o.multiple_from_first)::numeric,1) AS biggest_observed
    FROM tokens t JOIN outcomes o ON o.ca=t.ca AND o.snapshot_minutes=240
    WHERE t.gate_result='failed' AND t.first_seen > now()-($1||' days')::interval
    GROUP BY t.gate_fail_reason
    HAVING COUNT(*) FILTER (WHERE o.multiple_from_first>=3)>0
    ORDER BY would_have_3x DESC LIMIT 20`, [String(boundedDays)]);

  const hourOfDay = await q(`SELECT EXTRACT(HOUR FROM t.first_seen AT TIME ZONE 'UTC')::int AS hour_utc,
      COUNT(*) AS n,
      ROUND(AVG(o.multiple_from_first)::numeric,2) AS avg_multiple,
      ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY o.multiple_from_first))::numeric,2) AS median_multiple,
      ROUND((COUNT(*) FILTER (WHERE o.multiple_from_first>=2))::numeric/NULLIF(COUNT(*),0)*100,1) AS pct_2x_plus
    FROM tokens t JOIN outcomes o ON o.ca=t.ca AND o.snapshot_minutes=240
    WHERE t.gate_result='passed' AND t.first_seen > now()-($1||' days')::interval
    GROUP BY 1 ORDER BY 1`, [String(boundedDays)]);

  const insiderCorrelationLast24h = await q(`SELECT CASE WHEN insider_pct IS NULL THEN 'unverified'
        WHEN insider_pct<10 THEN '0-10%' WHEN insider_pct<20 THEN '10-20%' ELSE '20%+' END AS insider_band,
      COUNT(*) AS n,
      ROUND(AVG(o.multiple_from_first)::numeric,2) AS avg_multiple_4h,
      ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY o.multiple_from_first))::numeric,2) AS median_multiple_4h,
      ROUND((COUNT(*) FILTER (WHERE o.multiple_from_first>=2))::numeric/NULLIF(COUNT(*),0)*100,1) AS pct_2x_plus
    FROM tokens t JOIN outcomes o ON o.ca=t.ca AND o.snapshot_minutes=240
    WHERE t.gate_result='passed' AND t.first_seen > now()-interval '24 hours'
    GROUP BY insider_band ORDER BY insider_band`).catch(() => []);

  const insiderVerificationCoverage = (await q(`SELECT
      COUNT(*) FILTER (WHERE gate_result='passed')::int AS passed_tokens,
      COUNT(*) FILTER (WHERE gate_result='passed' AND insider_pct IS NOT NULL)::int AS insider_verified,
      COUNT(*) FILTER (WHERE gate_result='passed' AND entity_graph IS NOT NULL)::int AS graph_persisted,
      ROUND(100.0*COUNT(*) FILTER (WHERE gate_result='passed' AND insider_pct IS NOT NULL)
        /NULLIF(COUNT(*) FILTER (WHERE gate_result='passed'),0),2) AS insider_verified_pct
    FROM tokens WHERE first_seen>now()-interval '24 hours'`).catch(() => [{}]))[0] || {};

  const walletSourcePerformance = await q(`SELECT CASE
      WHEN discovered_from IN ('winner_mining','cobuyer_expansion') THEN discovered_from
      WHEN discovered_from IS NULL THEN 'original'
      WHEN LENGTH(discovered_from)>=32 THEN 'own_winner_mining'
      ELSE discovered_from END AS source,
      COUNT(*) AS wallets,
      COUNT(*) FILTER (WHERE active) AS configured_active,
      ROUND(AVG(win_rate)::numeric,3) AS avg_win_rate,
      COUNT(*) FILTER (WHERE win_rate IS NOT NULL) AS measured,
      COUNT(*) FILTER (WHERE quality_verdict='ELITE') AS elite,
      COUNT(*) FILTER (WHERE last_active>now()-interval '24 hours') AS recently_active_24h
    FROM smart_wallets GROUP BY 1 ORDER BY wallets DESC`).catch(() => []);

  const deployerRepPerformance = await q(`SELECT COALESCE(t.deployer_rep,'unlabeled') AS rep,
      COUNT(*) AS n, ROUND(AVG(o.multiple_from_first)::numeric,2) AS avg_multiple,
      ROUND((COUNT(*) FILTER (WHERE o.multiple_from_first>=2))::numeric/NULLIF(COUNT(*),0)*100,1) AS pct_2x_plus
    FROM tokens t JOIN outcomes o ON o.ca=t.ca AND o.snapshot_minutes=240
    WHERE t.gate_result='passed' AND t.first_seen > now()-($1||' days')::interval
    GROUP BY 1 ORDER BY pct_2x_plus DESC NULLS LAST`, [String(boundedDays)]).catch(() => []);

  const historicalOverrides = await q(`SELECT path,value,reason,updated_at,
      false AS active_in_runtime
    FROM filter_overrides ORDER BY updated_at DESC`).catch(() => []);
  const recentModelSuggestions = await q(`SELECT created_at,model_version,kind,payload,evidence,applied
    FROM model_suggestions ORDER BY created_at DESC LIMIT 30`).catch(() => []);

  return {
    generated: new Date().toISOString(),
    window: `last ${boundedDays} days`,
    currentModelVersion: MODEL_VERSION,
    learningMode: 'suggest-only learner; production values are human-applied and versioned in config.yaml',
    totals,
    funnelHealth,
    sourcePerformance,
    walletSourcePerformance,
    gateKillReasons,
    triggerPerformance,
    convictionPerformance,
    forwardSnapshotPerformance,
    hourOfDay,
    componentCalibration,
    scoreCalibration,
    falseKills,
    filterLearning: { runtime: learningDiag(), historicalOverrides },
    scoreCalibrationLearned: scorecalDiag(),
    forwardEvidence: forwardEvidenceDiag(),
    modelSuggestions: recentModelSuggestions,
    paperTrading: await paperScoreboard(boundedDays),
    paperQuoteStatuses: await paperQuoteStatusBreakdown(boundedDays),
    deployerRepPerformance,
    insiderVerificationCoverage,
    insiderCorrelationLast24h,
    configInForce: {
      source: 'config.yaml (human-applied governance)',
      weights: cfg().weights,
      triggerFloor: cfg().states.trigger_score_min,
      hardTopHolderCap: cfg().gates.hard_reject_top_holder_pct,
      insiderCeiling: cfg().bundle.max_insider_supply_pct,
      momentumRecommendationEligible: false,
    },
    readme: 'forwardSnapshotPerformance and componentCalibration use exact 60-minute-forward labels captured at 1/2/3/5/10/15 minutes. Means are highly outlier-sensitive; use medians and hit rates for decisions. modelSuggestions are advisory until committed to config.yaml. walletSourcePerformance distinguishes configured_active wallets from wallets that actually traded in the last 24 hours. insider_band=unverified means no persisted bundle measurement, not a measured zero. Momentum remains research-only.',
  };
}
