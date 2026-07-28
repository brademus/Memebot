import test from 'node:test';
import assert from 'node:assert/strict';
import { initDb, pool } from '../db';
import { waitForCorePaperSchema } from './schema-hardening';
import { initializeEvidenceSystemV3 } from './system-v3';

test('evidence system stamps active policy and journals execution mutations append-only', async () => {
  assert.ok(pool, 'DATABASE_URL must be configured for the evidence integration test');
  await initDb();
  await waitForCorePaperSchema();
  await initializeEvidenceSystemV3();

  const ca = `evidence-v3-${Date.now()}`;
  let paperId: number | null = null;
  try {
    await pool.query(`INSERT INTO tokens(ca,symbol,name,source,gate_result,last_state,last_score,subs)
      VALUES($1,'EV3','Evidence V3','pumpfun','passed','HEATING',70,'{}'::jsonb)`, [ca]);
    const inserted = await pool.query(`INSERT INTO paper_trades
      (ca,symbol,signal,entry_price,mark_entry_price,entry_score,peak_price,peak_at,last_price,last_at,
       target_multiple,quote_status,model_version,quote_key_present)
      VALUES($1,'EV3','trigger',1,1,70,1,now(),1,now(),3,'quote_pending','evidence-test',false)
      RETURNING id,policy_fingerprint`, [ca]);
    paperId = Number(inserted.rows[0].id);
    assert.match(String(inserted.rows[0].policy_fingerprint), /^[a-f0-9]{64}$/);

    await pool.query(`UPDATE paper_trades SET
      quote_status='curve_executable_simulated_priced',execution_eligible=true,
      position_sol=1.25,position_usd=100,quoted_out_usd=99,quoted_out_amount='1000000000',
      price_impact_pct=0.01,slippage_bps=150,fee_lamports=500000,router='pumpportal_curve',
      transaction_built=true,simulation_ok=true,simulation_error=NULL,simulation_units=120000,
      route_stability_bps=20,execution_score=0.9,execution_probe='{}'::jsonb
      WHERE id=$1`, [paperId]);
    await pool.query(`UPDATE paper_trades SET
      exit_quote_status='executable_simulated',exit_quoted_usd=310,
      exit_transaction_built=true,exit_simulation_ok=true,exit_simulation_error=NULL,
      exit_router='jupiter' WHERE id=$1`, [paperId]);

    const attempts = await pool.query(`SELECT stage,status,evidence,evidence_hash
      FROM execution_attempts WHERE paper_trade_id=$1 ORDER BY id`, [paperId]);
    assert.ok(attempts.rows.some(row => row.stage === 'entry' && row.status === 'curve_executable_simulated_priced'));
    assert.ok(attempts.rows.some(row => row.stage === 'exit' && row.status === 'executable_simulated'));
    assert.ok(attempts.rows.every(row => /^[a-f0-9]{32}$/.test(String(row.evidence_hash))));

    const before = attempts.rowCount;
    await pool.query(`UPDATE paper_trades SET exit_quote_status='executable_simulated' WHERE id=$1`, [paperId]);
    const after = await pool.query(`SELECT COUNT(*)::int AS n FROM execution_attempts WHERE paper_trade_id=$1`, [paperId]);
    assert.equal(after.rows[0].n, before, 'identical evidence must not create a duplicate journal record');

    const schema = await pool.query(`SELECT table_name FROM information_schema.tables
      WHERE table_schema=current_schema() AND table_name IN
      ('evidence_policy_epochs','paired_policy_observations','post_exit_shadows_v2',
       'runner_shadow_variants','evidence_experiment_recommendations')`);
    assert.equal(schema.rowCount, 5);
  } finally {
    if (paperId) await pool.query(`DELETE FROM paper_trades WHERE id=$1`, [paperId]);
    await pool.query(`DELETE FROM tokens WHERE ca=$1`, [ca]);
    await pool.end();
  }
});
