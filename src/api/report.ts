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
           ROUND(AVG(o.multiple_from_first)::numeric, 2) AS avg_multiple,
           ROUND((COUNT(*) FILTER (WHERE o.multiple_from_first >= 2))::numeric / NULLIF(COUNT(*),0) * 100, 1) AS pct_2x_plus,
           ROUND((COUNT(*) FILTER (WHERE o.multiple_from_first < 1))::numeric / NULLIF(COUNT(*),0) * 100, 1) AS pct_down
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
  const insiderCorr = await q(`
    SELECT CASE WHEN insider_pct IS NULL THEN 'unknown'
                WHEN insider_pct < 10 THEN '0-10%'
                WHEN insider_pct < 20 THEN '10-20%'
                ELSE '20%+' END AS insider_band,
           COUNT(*) AS n,
           ROUND(AVG(o.multiple_from_first)::numeric, 2) AS avg_multiple_4h
    FROM tokens t JOIN outcomes o ON o.ca = t.ca AND o.snapshot_minutes = 240
    WHERE t.gate_result = 'passed' ${win}
    GROUP BY insider_band ORDER BY insider_band`);

  // filter learning: what the bot changed about its own filters, with evidence
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

  return {
    generated: new Date().toISOString(),
    window: `last ${days} days`,
    totals,
    triggerPerformance: triggerPerf,
    convictionPerformance: convictionPerf,
    scoreCalibration: scoreBuckets,
    falseKills,
    filterLearning,
    insiderCorrelation: insiderCorr,
    readme: 'Paste this whole object to Claude to tune config.yaml. triggerPerformance = did BUY calls go up. convictionPerformance = the confirmed-buy tier measured from its own entry price (must beat triggers or tighten conviction thresholds). scoreCalibration = are high scores earning their weight. falseKills = gates rejecting winners (loosen these). insiderCorrelation = is the bundle gate threshold right.',
  };
}
