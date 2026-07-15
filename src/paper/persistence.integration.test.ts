import test from 'node:test';
import assert from 'node:assert/strict';
import { initDb, pool } from '../db';
import { MODEL_VERSION } from '../model/version';
import { openPaper } from './paper';

test('paper schema accepts versioned ON CONFLICT inserts in real Postgres', async () => {
  assert.ok(pool, 'DATABASE_URL must be configured for the persistence integration test');
  await initDb();

  const ca = `integration-${Date.now()}`;
  try {
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
  } finally {
    await pool.query(`DELETE FROM paper_trades WHERE ca=$1`, [ca]);
    await pool.end();
  }
});
