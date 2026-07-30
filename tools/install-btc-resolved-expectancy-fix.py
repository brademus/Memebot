from pathlib import Path


def replace_exact(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    if old not in text:
        raise SystemExit(f'missing expected text in {path}: {old[:160]!r}')
    file.write_text(text.replace(old, new, 1))


replace_exact(
    'src/btc/platform/ledger.ts',
    """    COALESCE(SUM(net_pnl_usd),0) net_pnl,
    AVG(result_r) FILTER (WHERE result_r IS NOT NULL) average_r,
    COALESCE(SUM(net_pnl_usd) FILTER (WHERE net_pnl_usd>0),0) gross_profit,
    ABS(COALESCE(SUM(net_pnl_usd) FILTER (WHERE net_pnl_usd<0),0)) gross_loss
""",
    """    COALESCE(SUM(net_pnl_usd) FILTER (WHERE status IN ('won','lost','liquidated')),0) net_pnl,
    AVG(result_r) FILTER (WHERE status IN ('won','lost','liquidated') AND result_r IS NOT NULL) average_r,
    COALESCE(SUM(net_pnl_usd) FILTER (
      WHERE status IN ('won','lost','liquidated') AND net_pnl_usd>0
    ),0) gross_profit,
    ABS(COALESCE(SUM(net_pnl_usd) FILTER (
      WHERE status IN ('won','lost','liquidated') AND net_pnl_usd<0
    ),0)) gross_loss
""",
)

replace_exact(
    'public/btc-dashboard.js',
    """    const alertTier = String(call.features?.actionableTier || 'standard');
    const book = call.book === 'actionable'
      ? alertTier === 'a_plus' ? 'A+ ACTIONABLE ALERT' : 'STANDARD ACTIONABLE ALERT'
      : 'STRATEGY RESEARCH';
""",
    """    const rawAlertTier = call.features?.actionableTier;
    const alertTier = rawAlertTier ? String(rawAlertTier) : 'legacy';
    const book = call.book === 'actionable'
      ? alertTier === 'a_plus'
        ? 'A+ ACTIONABLE ALERT'
        : alertTier === 'standard' ? 'STANDARD ACTIONABLE ALERT' : 'LEGACY ACTIONABLE CALL'
      : 'STRATEGY RESEARCH';
""",
)
replace_exact(
    'public/btc-dashboard.js',
    """        <div class="metric"><small>Projected policy</small><b>${call.book === 'actionable' ? escapeHtml(alertTier === 'a_plus' ? 'A+ PREMIUM' : 'STANDARD') : 'RESEARCH'} · ${number(call.features?.estimatedTargetRoiPct, 1)}% / ${number(call.features?.estimatedNetRR)}R</b></div>
""",
    """        <div class="metric"><small>Projected policy</small><b>${call.book === 'actionable' ? escapeHtml(alertTier === 'a_plus' ? 'A+ PREMIUM' : alertTier === 'standard' ? 'STANDARD' : 'LEGACY PRE-POLICY') : 'RESEARCH'} · ${number(call.features?.estimatedTargetRoiPct, 1)}% / ${number(call.features?.estimatedNetRR)}R</b></div>
""",
)

path = Path('src/btc/platform/platform.integration.test.ts')
text = path.read_text()
text = text.replace(
    "import { pool } from '../../db';\n",
    "import { pool } from '../../db';\nimport { strategyPerformance } from './ledger';\n",
    1,
)
marker = """  const event = await db.query(`SELECT call_id,event_type,reason FROM btc_call_events WHERE call_id='action-1'`);
  assert.deepEqual(event.rows, [{ call_id: 'action-1', event_type: 'entry_filled', reason: 'test event' }]);
"""
addition = marker + """

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
"""
if marker not in text:
    raise SystemExit('missing integration insertion marker')
path.write_text(text.replace(marker, addition, 1))

print('resolved-only BTC expectancy fix installed')
