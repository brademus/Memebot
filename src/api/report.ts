import { pool } from '../db';

// Weekly feedback report — the numbers you paste back for algorithm tuning.
// Answers: did TRIGGER picks go up? which score buckets hit? are gates killing winners?
export async function buildReport(days = 7): Promise<any> {
  if (!pool) return { note: 'no database attached — outcomes not being logged' };

  const q = async (sql: string, p: any[] = []) => (await pool!.query(sql, p)).rows;
  const win = `AND t.first_seen > now() - interval '${Math.max(1, Math.min(days, 90))} days'`;

  // 1. TRIGGER performance: of tokens we said BUY, how did they move by 1h/4h?
  const triggerPerf = await q(`
    SELECT o.snapshot_minutes AS mins,
           COUNT(*) AS n,
           ROUND(AVG(o.price_usd / NULLIF(t.trigger_price,0))::numeric, 2) AS avg_multiple,
           ROUND((COUNT(*) FILTER (WHERE o.price_usd / NULLIF(t.trigger_price,0) >= 2))::numeric / NULLIF(COUNT(*),0) * 100, 1) AS pct_2x_plus,
           ROUND((COUNT(*) FILTER (WHERE o.price_usd / NULLIF(t.trigger_price,0) < 1))::numeric / NULLIF(COUNT(*),0) * 100, 1) AS pct_down
    FROM tokens t JOIN outcomes o ON o.ca = t.ca
    WHERE t.triggered_at IS NOT NULL AND t.trigger_price > 0 ${win}
    GROUP BY o.snapshot_minutes ORDER BY o.snapshot_minutes`);

  // 1b. CONVICTION performance: the confirmed-buy tier, measured from ITS OWN entry
  // price. This is the tier's report card — it must beat triggerPerformance on
  // avg_multiple and pct_down or its thresholds need work.
  const convictionPerf = await q(`
    SELECT o.snapshot_minutes AS mins,
           COUNT(*) AS n,
           ROUND(AVG(o.price_usd / NULLIF(t.conviction_price, 0))::numeric, 2) AS avg_multiple,
           ROUND((COUNT(*) FILTER (WHERE o.price_usd / NULLIF(t.conviction_price,0) >= 2))::numeric / NULLIF(COUNT(*),0) * 100, 1) AS pct_2x_plus,
           ROUND((COUNT(*) FILTER (WHERE o.price_usd / NULLIF(t.conviction_price,0) < 1))::numeric / NULLIF(COUNT(*),0) * 100, 1) AS pct_down
    FROM tokens t JOIN outcomes o ON o.ca = t.ca
    WHERE t.conviction_at IS NOT NULL AND t.conviction_price > 0 ${win}
    GROUP BY o.snapshot_minutes ORDER BY o.snapshot_minutes`);

  // 1c. Launch-hour cohort: does hour-of-day carry signal? (validates/kills the
  // dead-hours prior in launch_signals with our own outcomes)
  const hourOfDay = await q(`
    SELECT EXTRACT(HOUR FROM t.first_seen AT TIME ZONE 'UTC')::int AS hour_utc,
           COUNT(*) AS n,
           ROUND(AVG(o.multiple_from_first)::numeric, 2) AS avg_multiple,
           ROUND((COUNT(*) FILTER (WHERE o.multiple_from_first >= 2))::numeric / NULLIF(COUNT(*),0) * 100, 1) AS pct_2x_plus
    FROM tokens t JOIN outcomes o ON o.ca = t.ca AND o.snapshot_minutes = 240
    WHERE t.gate_result = 'passed' ${win}
    GROUP BY 1 ORDER BY 1`);

  // 1d. COMPONENT calibration: the composite score anti-predicts (60-80 band 0.86x,
  // 80+ band 0.52x — worse than junk). The question is WHICH components carry
  // signal and which carry the anti-signal. Terciles per component: if tercile 3
  // (highest values) doesn't beat tercile 1, that component's weight is buying
  // nothing — or worse, selecting tops. Reweight cfg().weights from THIS table.
  // componentCalibration is built from early_subs — the SAME snapshot the scoring
  // calibrator trains on (frozen young). Reading mature `subs` here would put the
  // human and the machine on different evidence AND is confounded by survival
  // (winners live longer, so their final freshness is mechanically low — a
  // measurement artifact, not market truth). The mature version is kept as
  // componentCalibrationMature purely for the contrast.
  const tercileQuery = (col: string, comp: string) => `
      WITH s AS (
        SELECT NTILE(3) OVER (ORDER BY (t.${col}->>'${comp}')::float) AS tercile,
               o.multiple_from_first AS m
        FROM tokens t JOIN outcomes o ON o.ca = t.ca AND o.snapshot_minutes = 240
        WHERE t.gate_result = 'passed' AND t.${col} IS NOT NULL AND t.${col} ? '${comp}' ${win})
      SELECT tercile, COUNT(*) AS n,
             ROUND(AVG(m)::numeric, 2) AS avg_multiple,
             ROUND((COUNT(*) FILTER (WHERE m >= 2))::numeric / NULLIF(COUNT(*),0) * 100, 1) AS pct_2x_plus
      FROM s GROUP BY tercile ORDER BY tercile`;
  const componentCalibration: Record<string, any> = {};
  const componentCalibrationMature: Record<string, any> = {};
  for (const comp of ['freshness', 'liquidity', 'buyPressure', 'holderGrowth', 'smartMoney']) {
    componentCalibration[comp] = await q(tercileQuery('early_subs', comp)).catch(() => []);
    componentCalibrationMature[comp] = await q(tercileQuery('subs', comp)).catch(() => []);
  }

  // 2. Score-bucket calibration: do higher scores actually predict bigger multiples? (4h)
  const scoreBuckets = await q(`
    SELECT width_bucket(GREATEST(t.peak_score, t.last_score), 0, 100, 5) * 20 AS score_band_top,
           COUNT(*) AS n,
           ROUND(AVG(o.multiple_from_first)::numeric, 2) AS avg_multiple_4h,
           ROUND((COUNT(*) FILTER (WHERE o.multiple_from_first >= 2))::numeric / NULLIF(COUNT(*),0) * 100, 1) AS pct_2x_plus
    FROM tokens t JOIN outcomes o ON o.ca = t.ca AND o.snapshot_minutes = 240
    WHERE t.gate_result = 'passed' AND (t.peak_score IS NOT NULL OR t.last_score IS NOT NULL) ${win}
    GROUP BY score_band_top ORDER BY score_band_top`);

  // 3. False kills: killed tokens that would have mooned (ref price = kill price)
  const falseKills = await q(`
    SELECT t.gate_fail_reason AS reason,
           COUNT(*) AS killed,
           COUNT(*) FILTER (WHERE o.multiple_from_first >= 3) AS would_have_3x,
           ROUND(MAX(o.multiple_from_first)::numeric, 1) AS biggest_missed
    FROM tokens t JOIN outcomes o ON o.ca = t.ca AND o.snapshot_minutes = 240
    WHERE t.gate_result = 'failed' ${win}
    GROUP BY t.gate_fail_reason
    HAVING COUNT(*) FILTER (WHERE o.multiple_from_first >= 3) > 0
    ORDER BY would_have_3x DESC LIMIT 15`);

  // 4. Insider-pct correlation: does lower insider% actually mean better outcomes?
  // Two cohorts: all-time, and last-24h only. The bundle pagination fix (creation-
  // walk instead of newest-100) deployed 2026-07-11 — verdicts before it could mark
  // busy tokens FALSELY CLEAN. Verification happens within ~40min of first_seen, so
  // the 24h cohort is the trustworthy read on the clean-band premium.
  const insiderQ = (extra: string) => `
    SELECT CASE WHEN insider_pct IS NULL THEN 'unknown'
                WHEN insider_pct < 10 THEN '0-10%'
                WHEN insider_pct < 20 THEN '10-20%'
                ELSE '20%+' END AS insider_band,
           COUNT(*) AS n,
           ROUND(AVG(o.multiple_from_first)::numeric, 2) AS avg_multiple_4h
    FROM tokens t JOIN outcomes o ON o.ca = t.ca AND o.snapshot_minutes = 240
    WHERE t.gate_result = 'passed' ${win} ${extra}
    GROUP BY insider_band ORDER BY insider_band`;
  // NEW research signals — measured on OUR outcomes before being trusted (laws).
  const deployerRepPerformance = await q(`
    SELECT COALESCE(deployer_rep,'unlabeled') AS rep, COUNT(*) AS n,
           ROUND(AVG(o.multiple_from_first)::numeric, 2) AS avg_multiple,
           ROUND((COUNT(*) FILTER (WHERE o.multiple_from_first >= 2))::numeric / NULLIF(COUNT(*),0) * 100, 1) AS pct_2x_plus
    FROM tokens t JOIN outcomes o ON o.ca = t.ca AND o.snapshot_minutes = 240
    WHERE t.gate_result = 'passed' ${win}
    GROUP BY 1 ORDER BY avg_multiple DESC NULLS LAST`).catch(() => []);
  const clusterVsRaw = await q(`
    SELECT CASE WHEN insider_cluster_pct IS NULL THEN 'unmeasured'
                WHEN insider_cluster_pct > insider_pct + 5 THEN 'cluster_caught_more'
                ELSE 'cluster_matched_raw' END AS bucket,
           COUNT(*) AS n,
           ROUND(AVG(o.multiple_from_first)::numeric, 2) AS avg_multiple
    FROM tokens t JOIN outcomes o ON o.ca = t.ca AND o.snapshot_minutes = 240
    WHERE t.gate_result = 'passed' AND t.insider_pct IS NOT NULL ${win}
    GROUP BY 1 ORDER BY 1`).catch(() => []);
  const insiderCorr = await q(insiderQ(''));
  const insiderCorr24h = await q(insiderQ(`AND t.first_seen > now() - interval '24 hours'`)).catch(() => []);

  // AI NARRATIVE READ scorecard: does the AI's verdict correlate with outcomes?
  // This is the accountability for putting an LLM in the loop — if STRONG doesn't
  // beat WEAK on avg_multiple, the read is noise and ai.conviction_enabled -> false.
  const aiConvictionScorecard = await q(`
    SELECT ac.verdict,
           COUNT(*) AS n,
           ROUND(AVG(o.multiple_from_first)::numeric, 2) AS avg_multiple,
           ROUND((COUNT(*) FILTER (WHERE o.multiple_from_first >= 2))::numeric / NULLIF(COUNT(*),0) * 100, 1) AS pct_2x_plus
    FROM ai_conviction ac JOIN outcomes o ON o.ca = ac.ca AND o.snapshot_minutes = 240
    WHERE ac.at > now() - interval '${Math.max(1, Math.min(days, 90))} days'
    GROUP BY ac.verdict ORDER BY avg_multiple DESC NULLS LAST`).catch(() => []);

  // filter learning: what the bot changed about its own filters, with evidence
  const scoreCalibration_learned = {
    currentWeights: await q(`SELECT component, weight, updated_at FROM learned_weights WHERE LEFT(component, 1) <> '_' ORDER BY weight DESC`).catch(() => []),
    triggerFloor: await q(`SELECT weight FROM learned_weights WHERE component = '_trigger_floor'`).catch(() => []),
    recentChanges: await q(`SELECT at, component, old_weight, new_weight, evidence FROM weight_tuning_log ORDER BY at DESC LIMIT 20`).catch(() => []),
  };

  const filterLearning = {
    activeOverrides: await q(`SELECT path, value, reason, updated_at FROM filter_overrides ORDER BY updated_at DESC`).catch(() => []),
    recentDecisions: await q(`SELECT at, path, old_value, new_value, evidence FROM filter_tuning_log ORDER BY at DESC LIMIT 20`).catch(() => []),
  };

  const totals = (await q(`SELECT
     COUNT(*) AS total_seen,
     COUNT(*) FILTER (WHERE gate_result='passed') AS passed,
     COUNT(*) FILTER (WHERE gate_result='failed') AS killed,
     COUNT(*) FILTER (WHERE triggered_at IS NOT NULL) AS triggered,
     COUNT(*) FILTER (WHERE conviction_at IS NOT NULL) AS convictions
     FROM tokens`))[0];

  // ---- DISCOVERY SOURCE performance: which engine finds winners? ----
  const sourcePerformance = await q(`
    SELECT t.source, COUNT(*) AS n,
           ROUND(AVG(o.multiple_from_first)::numeric, 2) AS avg_multiple,
           ROUND((COUNT(*) FILTER (WHERE o.multiple_from_first >= 2))::numeric / NULLIF(COUNT(*),0) * 100, 1) AS pct_2x_plus,
           MAX(o.multiple_from_first) AS best
    FROM tokens t JOIN outcomes o ON o.ca = t.ca AND o.snapshot_minutes = 240
    WHERE t.gate_result = 'passed' ${win}
    GROUP BY t.source ORDER BY avg_multiple DESC NULLS LAST`).catch(() => []);

  // ---- WALLET SOURCE performance: are winner-mined / co-buyer wallets good? ----
  const walletSourcePerformance = await q(`
    SELECT CASE
             WHEN discovered_from IN ('winner_mining', 'cobuyer_expansion') THEN discovered_from
             WHEN discovered_from IS NULL THEN 'original'
             WHEN LENGTH(discovered_from) >= 32 THEN 'own_winner_mining'   -- stores the winner MINT it was mined from
             ELSE discovered_from END AS source,
           COUNT(*) AS wallets,
           COUNT(*) FILTER (WHERE active) AS active,
           ROUND(AVG(win_rate)::numeric, 3) AS avg_win_rate,
           COUNT(*) FILTER (WHERE win_rate IS NOT NULL) AS measured,
           COUNT(*) FILTER (WHERE quality_verdict = 'ELITE') AS elite,
           COUNT(*) FILTER (WHERE last_active > now() - interval '24 hours') AS active_today
    FROM smart_wallets GROUP BY 1 ORDER BY wallets DESC`).catch(() => []);

  // ---- FUNNEL health: where do coins die? (the live pipeline picture) ----
  const funnelHealth = await q(`
    SELECT
      COUNT(*) AS total_seen,
      COUNT(*) FILTER (WHERE gate_result = 'passed') AS passed_gates,
      COUNT(*) FILTER (WHERE gate_result = 'failed') AS killed_gates,
      COUNT(*) FILTER (WHERE triggered_at IS NOT NULL) AS triggered,
      COUNT(*) FILTER (WHERE conviction_at IS NOT NULL) AS conviction
    FROM tokens t WHERE 1=1 ${win}`).catch(() => []);

  // ---- top gate-kill reasons overall (not just false-kills) ----
  const gateKillReasons = await q(`
    SELECT gate_fail_reason AS reason, COUNT(*) AS n
    FROM tokens t WHERE t.gate_result = 'failed' AND t.gate_fail_reason IS NOT NULL ${win}
    GROUP BY 1 ORDER BY 2 DESC LIMIT 12`).catch(() => []);

  return {
    generated: new Date().toISOString(),
    window: `last ${days} days`,
    totals,
    funnelHealth,
    sourcePerformance,
    walletSourcePerformance,
    gateKillReasons,
    triggerPerformance: triggerPerf,
    convictionPerformance: convictionPerf,
    hourOfDay,
    componentCalibration,
    componentCalibrationMature,
    scoreCalibration: scoreBuckets,
    falseKills,
    filterLearning,
    scoreCalibrationLearned: scoreCalibration_learned,
    aiConvictionScorecard,
    deployerRepPerformance,
    clusterVsRaw,
    insiderCorrelation: insiderCorr,
    insiderCorrelationLast24h: insiderCorr24h,
    readme: 'Paste this whole object to Claude to tune config.yaml. triggerPerformance = did BUY calls go up. convictionPerformance = the confirmed-buy tier measured from its own entry price (must beat triggers or tighten conviction thresholds). scoreCalibration = are high scores earning their weight. aiConvictionScorecard = does the AI narrative read predict (STRONG must beat WEAK on avg_multiple or disable it). componentCalibration = WHICH components carry signal (tercile 3 must beat tercile 1 or that weight is dead/anti-signal — reweight from this). falseKills = gates rejecting winners (loosen these). insiderCorrelation = is the bundle gate threshold right (all-time — MIXES pre-fix verdicts). insiderCorrelationLast24h = verified after the 2026-07-11 pagination fix; TRUST THIS ONE for the clean-band premium. insiderCorrelationLast24h = SAME but only tokens verified after the 2026-07-11 pagination fix — TRUST THIS ONE for the clean-band premium; the all-time version mixes in pre-fix verdicts that could be falsely clean. sourcePerformance = which DISCOVERY ENGINE (pumpfun/momentum/wallet/winner_miner) finds winners — kill or boost engines from this. walletSourcePerformance = are winner-mined/co-buyer wallets actually good (avg_win_rate) or noise. funnelHealth = the seen->passed->triggered->conviction pipeline. gateKillReasons = what the gates kill most (overall, not just false-kills). deployerRepPerformance = does our deployer reputation label (FRESH/KNOWN/SERIAL/SERIAL_DEAD) predict — FRESH must beat SERIAL or the signal is dead. clusterVsRaw = when cluster-merge caught MORE hidden supply than raw insider%, were those tokens actually worse (validates the MELT shared-funder heuristic on our outcomes).',
  };
}
