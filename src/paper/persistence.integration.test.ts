import test from 'node:test';
import assert from 'node:assert/strict';
import { initDb, pool } from '../db';
import { ensureLeadershipSchema } from '../leadership';
import { MODEL_VERSION } from '../model/version';
import { openPaper } from './paper';

test('fresh database leadership, paper and forward evidence SQL contracts execute in real Postgres', async () => {
  assert.ok(pool, 'DATABASE_URL must be configured for the persistence integration test');

  // Worker election happens before initDb() during production boot. Prove an empty or
  // replaced Railway volume can create the coordination table without migrations.
  await pool.query(`DROP TABLE IF EXISTS leadership_claims`);
  await ensureLeadershipSchema();
  const leadershipColumns = await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema=current_schema() AND table_name='leadership_claims'
      ORDER BY column_name`,
  );
  assert.deepEqual(
    leadershipColumns.rows.map(row => row.column_name),
    ['claimed_at', 'name', 'value'],
  );

  await initDb();

  const ca = `integration-${Date.now()}`;
  let observationId: number | null = null;
  let snapshotId: number | null = null;
  try {
    await pool.query(
      `INSERT INTO tokens (ca,symbol,name,source,gate_result,last_state,last_score,subs)
       VALUES ($1,'INT','Integration','pumpfun','passed','HEATING',70,'{}'::jsonb)`,
      [ca],
    );

    await openPaper(ca, 'INT', 'model_raw', 1, 70, undefined, { skipExecutionQuote: true });
    await openPaper(ca, 'INT', 'model_raw', 1, 70, undefined, { skipExecutionQuote: true });

    const current = await pool.query(
      `SELECT COUNT(*)::int AS n FROM paper_trades
        WHERE ca=$1 AND signal='model_raw' AND model_version=$2`,
      [ca, MODEL_VERSION],
    );
    assert.equal(current.rows[0].n, 1, 'duplicate current-model insert must be idempotent');

    await pool.query(
      `INSERT INTO paper_trades
         (ca,symbol,signal,entry_price,mark_entry_price,entry_score,peak_price,peak_at,last_price,last_at,
          target_multiple,quote_status,model_version,quote_key_present)
       VALUES ($1,'INT','model_raw',1,1,70,1,now(),1,now(),3,'legacy_mark','legacy',false)
       ON CONFLICT (ca,signal,model_version) DO NOTHING`,
      [ca],
    );
    const versions = await pool.query(
      `SELECT model_version FROM paper_trades WHERE ca=$1 AND signal='model_raw' ORDER BY model_version`,
      [ca],
    );
    assert.deepEqual(versions.rows.map(row => row.model_version), ['legacy', MODEL_VERSION].sort());

    const index = await pool.query(
      `SELECT indexdef FROM pg_indexes
        WHERE schemaname=current_schema() AND tablename='paper_trades'
          AND indexname='uq_paper_trades_ca_signal_model'`,
    );
    assert.equal(index.rowCount, 1, 'versioned unique index must exist after migrations');

    const observation = await pool.query(
      `INSERT INTO signal_observations
         (ca,observation_key,captured_at,captured_age_seconds,price_usd,base_score,source,dex,
          regime_id,model_version,recommendation_eligible,feature_vector,burst_features,entity_features,decision)
       VALUES ($1,'age_1m',now()-interval '61 minutes',60,1,70,'pumpfun','pumpfun',
               'test:normal',$2,true,'{}'::jsonb,'{}'::jsonb,NULL,NULL)
       RETURNING id`,
      [ca, MODEL_VERSION],
    );
    observationId = Number(observation.rows[0].id);
    await pool.query(
      `INSERT INTO signal_observation_outcomes (observation_id,horizon_minutes)
       VALUES ($1::bigint,$2::int)`,
      [observationId, 60],
    );
    await pool.query(
      `UPDATE signal_observation_outcomes
          SET attempts=$3::int,last_error='retry-test',
              next_attempt_at=now()+make_interval(mins => $4::int),status=$5::text
        WHERE observation_id=$1::bigint AND horizon_minutes=$2::int`,
      [observationId, 60, 1, 2, 'pending'],
    );
    await pool.query(
      `UPDATE signal_observation_outcomes
          SET status='resolved',price_usd=$3::numeric,
              multiple=$3::numeric/NULLIF($4::numeric,0),resolved_at=now(),last_error=NULL
        WHERE observation_id=$1::bigint AND horizon_minutes=$2::int`,
      [observationId, 60, 2, 1],
    );
    const outcome = await pool.query(
      `SELECT status,multiple FROM signal_observation_outcomes
       WHERE observation_id=$1 AND horizon_minutes=60`, [observationId],
    );
    assert.equal(outcome.rows[0].status, 'resolved');
    assert.equal(Number(outcome.rows[0].multiple), 2);

    const snapshot = await pool.query(
      `INSERT INTO score_snapshots
         (ca,snapshot_age_min,captured_age_seconds,captured_at,price_usd,score,raw,source,
          recommendation_eligible,model_version,forward_minutes)
       VALUES ($1,1,60,now()-interval '61 minutes',1,70,'{}'::jsonb,'pumpfun',true,$2,60)
       RETURNING id`,
      [ca, MODEL_VERSION],
    );
    snapshotId = Number(snapshot.rows[0].id);
    await pool.query(
      `UPDATE score_snapshots
          SET resolve_attempts=$2::int,last_resolve_error='retry-test',
              next_resolve_at=now()+make_interval(mins => $3::int),
              resolve_status=CASE WHEN $2::int >= $4::int THEN 'unresolved' ELSE 'pending' END
        WHERE id=$1::bigint`,
      [snapshotId, 1, 2, 8],
    );
    await pool.query(
      `UPDATE score_snapshots
          SET forward_price_usd=$2::numeric,
              forward_multiple=$2::numeric/NULLIF(price_usd,0),
              resolved_at=now(),resolve_status='resolved',last_resolve_error=NULL
        WHERE id=$1::bigint AND resolve_status='pending'`,
      [snapshotId, 2],
    );
    const scoreOutcome = await pool.query(
      `SELECT resolve_status,forward_multiple FROM score_snapshots WHERE id=$1`, [snapshotId],
    );
    assert.equal(scoreOutcome.rows[0].resolve_status, 'resolved');
    assert.equal(Number(scoreOutcome.rows[0].forward_multiple), 2);
  } finally {
    if (observationId) await pool.query(`DELETE FROM signal_observations WHERE id=$1`, [observationId]);
    if (snapshotId) await pool.query(`DELETE FROM score_snapshots WHERE id=$1`, [snapshotId]);
    await pool.query(`DELETE FROM paper_trades WHERE ca=$1`, [ca]);
    await pool.query(`DELETE FROM tokens WHERE ca=$1`, [ca]);
    await pool.end();
  }
});
