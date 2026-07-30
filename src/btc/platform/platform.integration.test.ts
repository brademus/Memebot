import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import test from 'node:test';
import { pool } from '../../db';
import { strategyPerformance } from './ledger';

test('BTC v2 schema enforces strategy identity, research isolation and actionable portfolio limits', async () => {
  const db = pool;
  assert.ok(db, 'DATABASE_URL must be configured for the BTC platform integration test');
  const schema = fs.readFileSync(path.join(process.cwd(), 'schema-btc.sql'), 'utf8');
  await db.query(schema);
  await db.query(`TRUNCATE btc_alert_deliveries,btc_pnl_snapshots,btc_fills,btc_call_events,
    btc_paper_calls,btc_risk_decisions,btc_signal_candidates,btc_strategy_versions,
    btc_strategy_definitions CASCADE`);

  await db.query(`INSERT INTO btc_strategy_definitions(strategy_id,strategy_name,description,mode)
    VALUES('strategy-a','Strategy A','test','actionable'),('strategy-b','Strategy B','test','actionable')`);
  await db.query(`INSERT INTO btc_strategy_versions(strategy_id,strategy_version,leverage_cap,configuration,code_fingerprint)
    VALUES('strategy-a','1.0.0',50,'{}','a'),('strategy-b','1.0.0',25,'{}','b')`);

  const insertCall = async (id: string, book: 'research' | 'actionable', strategy: string, notional = 1000) => db.query(`
    INSERT INTO btc_paper_calls
      (call_id,book,strategy_id,strategy_version,strategy_name,supporting_strategies,direction,status,
       margin_usd,leverage,notional_usd,entry_price,current_price,stop_price,target_price,
       liquidation_price,confidence,opened_at,realized_pnl_usd,unrealized_pnl_usd,net_pnl_usd,
       roi_pct,current_r,max_favorable_r,max_adverse_r,remaining_fraction,runner_activated,
       fees_usd,funding_usd,entry_alert_at,simulated_fill_at,rationale,features)
    VALUES($1,$2,$3,'1.0.0',$3,'[]','long','open',100,$4,$5,100000,100000,99900,100300,
      98000,80,now(),0,0,0,0,0,0,0,1,false,0,0,now(),now(),'[]','{}')`,
  [id, book, strategy, Math.round(notional / 100), notional]);

  await insertCall('research-a-1', 'research', 'strategy-a');
  await assert.rejects(insertCall('research-a-2', 'research', 'strategy-a'), /btc_one_research_call_per_strategy_idx|duplicate key/i);

  await insertCall('action-1', 'actionable', 'strategy-a', 2000);
  await insertCall('action-2', 'actionable', 'strategy-b', 2000);
  await insertCall('action-3', 'actionable', 'strategy-a', 2000);
  await assert.rejects(insertCall('action-4', 'actionable', 'strategy-b', 500), /active-call limit reached/i);

  await db.query(`INSERT INTO btc_call_events(call_id,event_type,event_at,price,reason,snapshot)
    VALUES('action-1','entry_filled',now(),100000,'test event','{}')`);
  const event = await db.query(`SELECT call_id,event_type,reason FROM btc_call_events WHERE call_id='action-1'`);
  assert.deepEqual(event.rows, [{ call_id: 'action-1', event_type: 'entry_filled', reason: 'test event' }]);


  const insertPerformanceCall = async (
    id: string,
    book: 'research' | 'actionable',
    status: 'open' | 'won' | 'lost',
    netPnlUsd: number,
    resultR: number | null,
  ) => db.query(`
    INSERT INTO btc_paper_calls
      (call_id,book,strategy_id,strategy_version,strategy_name,supporting_strategies,direction,status,
       margin_usd,leverage,notional_usd,entry_price,current_price,stop_price,target_price,
       liquidation_price,confidence,opened_at,closed_at,realized_pnl_usd,unrealized_pnl_usd,net_pnl_usd,
       roi_pct,current_r,result_r,max_favorable_r,max_adverse_r,remaining_fraction,runner_activated,
       fees_usd,funding_usd,entry_alert_at,simulated_fill_at,rationale,features)
    VALUES($1,$2,'strategy-b','1.0.0','Strategy B','[]','long',$3,100,10,1000,
      100000,100000,99900,100300,98000,80,now() - interval '1 minute',
      CASE WHEN $3='open' THEN NULL ELSE now() END,
      CASE WHEN $3='open' THEN 0 ELSE $4 END,
      CASE WHEN $3='open' THEN $4 ELSE 0 END,
      $4,$4,COALESCE($5::numeric,0),$5::numeric,1.5,-1,1,false,0,0,now(),now(),'[]','{}')`,
  [id, book, status, netPnlUsd, resultR]);

  await insertPerformanceCall('research-b-win', 'research', 'won', 12, 1.2);
  await insertPerformanceCall('research-b-loss', 'research', 'lost', -4, -0.5);
  await insertPerformanceCall('research-b-open', 'research', 'open', 500, null);
  await db.query(`UPDATE btc_paper_calls SET status='won',closed_at=now(),realized_pnl_usd=1000,
    unrealized_pnl_usd=0,net_pnl_usd=1000,roi_pct=1000,current_r=10,result_r=10
    WHERE call_id='action-2'`);

  const [performance] = await strategyPerformance([{
    id: 'strategy-b',
    version: '1.0.0',
    name: 'Strategy B',
    description: 'test',
    mode: 'actionable' as const,
    leverageCap: 25,
    evaluate: () => [],
  }]);
  assert.equal(performance.totalCalls, 3, 'only research-book calls belong in research performance');
  assert.equal(performance.activeCalls, 1);
  assert.equal(performance.wins, 1);
  assert.equal(performance.losses, 1);
  assert.equal(performance.netPnlUsd, 8, 'open and actionable P&L must not affect promotion evidence');
  assert.ok(Math.abs(Number(performance.averageR) - 0.35) < 1e-9);
  assert.equal(performance.profitFactor, 3, 'profit factor must use resolved research calls only');
});
