import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { pool } from '../db';

test('BTC paper schema is idempotent and enforces one-open and daily limits', async () => {
  const db = pool;
  assert.ok(db, 'DATABASE_URL must be configured for the BTC persistence integration test');
  const schema = fs.readFileSync(path.join(process.cwd(), 'schema-btc.sql'), 'utf8');

  await db.query('DROP TABLE IF EXISTS btc_calls CASCADE');
  await db.query('DROP FUNCTION IF EXISTS btc_enforce_daily_paper_limits() CASCADE');
  await db.query(schema);
  await db.query(schema);

  const insert = async (id: string, openedAt: string) => db.query(
    `INSERT INTO btc_calls
       (id,strategy_version,direction,entry_price,stop_price,target_price,confidence,risk_reward,status,opened_at,setup)
     VALUES ($1,'btc-momentum-v1.0.0','long',100,99,102.5,85,2.5,'open',$2::timestamptz,'{}'::jsonb)`,
    [id, openedAt],
  );

  const now = new Date();
  const firstAt = new Date(now.getTime() - 2 * 60 * 60_000).toISOString();
  const secondAt = new Date(now.getTime() - 60 * 60_000).toISOString();
  const thirdAt = now.toISOString();

  await insert('btc-integration-1', firstAt);
  await assert.rejects(insert('btc-integration-duplicate-open', firstAt), /duplicate key value|btc_one_open_call_idx/i);
  await db.query(
    `UPDATE btc_calls SET status='won',closed_at=opened_at+interval '30 minutes',exit_price=102.5,
       exit_reason='target_2_5r',result_r=2.5 WHERE id='btc-integration-1'`,
  );

  await insert('btc-integration-2', secondAt);
  await db.query(
    `UPDATE btc_calls SET status='lost',closed_at=opened_at+interval '20 minutes',exit_price=99,
       exit_reason='stop',result_r=-1 WHERE id='btc-integration-2'`,
  );

  await assert.rejects(insert('btc-integration-3', thirdAt), /daily call limit reached/i);
  const rows = await db.query(`SELECT id,status,result_r FROM btc_calls ORDER BY opened_at`);
  assert.deepEqual(rows.rows.map(row => [row.id, row.status, Number(row.result_r)]), [
    ['btc-integration-1', 'won', 2.5],
    ['btc-integration-2', 'lost', -1],
  ]);
});
