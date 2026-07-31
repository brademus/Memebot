import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { pool } from '../db';
import {
  initializeBtcPlatformSchema,
  insertCall,
  persistCandidate,
  persistRiskDecision,
  registerStrategies,
} from '../btc/platform/ledger';
import { buildBtcTradeReport } from './btc-report';

const integration = pool ? test : test.skip;

integration('BTC report joins calls to decisions, events, fills, P&L paths, and entry market evidence', async () => {
  await initializeBtcPlatformSchema();
  const suffix = randomUUID();
  const strategyId = `btc-report-test-${suffix}`;
  const strategyVersion = '1.0.0-test';
  const candidateId = `candidate-${suffix}`;
  const callId = `call-${suffix}`;
  const now = Date.now();
  const openedAt = now - 60_000;
  const closedAt = now - 10_000;
  const marketAt = new Date(openedAt - 1_000);

  const strategy = {
    id: strategyId,
    version: strategyVersion,
    name: 'BTC Report Integration Strategy',
    description: 'Integration-only strategy definition.',
    mode: 'shadow' as const,
    leverageCap: 5,
    evaluate: () => [],
  };
  const candidate: any = {
    id: candidateId,
    strategyId,
    strategyVersion,
    strategyName: strategy.name,
    mode: 'shadow',
    direction: 'long',
    setupType: 'integration_report_setup',
    createdAt: openedAt - 5_000,
    entryMethod: 'retest',
    preferredEntry: 100_000,
    entryZoneLow: 99_990,
    entryZoneHigh: 100_010,
    doNotChasePrice: 100_100,
    expiresAt: openedAt + 30_000,
    structuralStop: 99_500,
    initialTarget: 101_500,
    extendedTarget: 102_000,
    maximumRealisticTarget: 101_500,
    minimumRR: 3,
    strategyLeverageCap: 5,
    expectedHoldingMinutes: 60,
    exitModel: 'fixed',
    scores: { signal: 80, regime: 80, execution: 90, data: 100 },
    invalidationReasons: [],
    rationale: ['integration report candidate'],
    features: { integrationFixture: true },
  };
  const plan: any = {
    approved: true,
    rejectionReasons: [],
    marginUsd: 100,
    leverage: 5,
    notionalUsd: 500,
    entryPrice: 100_000,
    stopPrice: 99_500,
    targetPrice: 101_500,
    extendedTargetPrice: 102_000,
    liquidationPrice: 82_000,
    liquidationBufferPct: 17.5,
    estimatedRiskUsd: 3,
    estimatedRewardUsd: 6,
    estimatedNetRR: 2,
    estimatedTargetRoiPct: 6,
    actionableTier: null,
    expectancyEvidence: null,
    costs: {
      entryFeeUsd: 0.25,
      exitFeeUsd: 0.25,
      entrySlippageUsd: 0.05,
      exitSlippageUsd: 0.05,
      spreadUsd: 0.02,
      expectedFundingUsd: 0,
      totalEstimatedUsd: 0.62,
    },
  };
  const call: any = {
    id: callId,
    book: 'research',
    strategyId,
    strategyVersion,
    strategyName: strategy.name,
    supportingStrategies: [strategyId],
    direction: 'long',
    status: 'lost',
    marginUsd: 100,
    leverage: 5,
    notionalUsd: 500,
    entryPrice: 100_000,
    currentPrice: 99_500,
    stopPrice: 99_500,
    targetPrice: 101_500,
    extendedTargetPrice: 102_000,
    liquidationPrice: 82_000,
    confidence: 85,
    openedAt,
    closedAt,
    exitPrice: 99_500,
    exitReason: 'integration structural stop',
    realizedPnlUsd: -3,
    unrealizedPnlUsd: 0,
    netPnlUsd: -3,
    roiPct: -3,
    currentR: -1,
    resultR: -1,
    maxFavorableR: 0.2,
    maxAdverseR: -1,
    remainingFraction: 0,
    runnerActivated: false,
    trailingStopPrice: null,
    feesUsd: 0.5,
    fundingUsd: 0,
    entryAlertAt: openedAt,
    simulatedFillAt: openedAt,
    rationale: ['integration report call'],
    features: {
      estimatedRiskUsd: 3,
      estimatedRewardUsd: 6,
      estimatedNetRR: 2,
      estimatedTargetRoiPct: 6,
      totalModeledCostsUsd: 0.62,
      grossPnlUsd: -2.5,
      projectedExitCostsUsd: 0,
      grossMfePct: 0.1,
      grossMaePct: -0.5,
      entryRegimeDirection: 'range',
    },
  };

  try {
    await registerStrategies([strategy]);
    assert.equal(await persistCandidate(candidate), true);
    await persistRiskDecision(candidate, 'research', plan);
    await insertCall(call);
    await pool!.query(`INSERT INTO btc_call_events
      (call_id,event_type,event_at,price,reason,realized_pnl_delta_usd,snapshot)
      VALUES($1,'position_closed',$2,$3,$4,$5,$6::jsonb)`, [
      callId, new Date(closedAt), 99_500, 'integration structural stop', -3,
      JSON.stringify({ status: 'lost', currentR: -1 }),
    ]);
    await pool!.query(`INSERT INTO btc_fills
      (call_id,fill_at,side,purpose,price,notional_usd,fraction,fee_usd,slippage_usd,metadata)
      VALUES($1,$2,'buy','entry',100000,500,1,0.25,0.05,$3::jsonb)`, [
      callId, new Date(openedAt), JSON.stringify({ fixture: true }),
    ]);
    await pool!.query(`INSERT INTO btc_pnl_snapshots
      (call_id,snapshot_at,mark_price,executable_exit_price,realized_pnl_usd,unrealized_pnl_usd,
       net_pnl_usd,roi_pct,current_r,liquidation_buffer_pct)
      VALUES($1,date_trunc('minute',$2::timestamptz),100050,100040,-0.3,0.2,-0.1,-0.1,-0.03,17)`, [
      callId, new Date(openedAt),
    ]);
    await pool!.query(`INSERT INTO btc_market_snapshots
      (snapshot_at,reference_venue,last_price,bid_price,ask_price,mark_price,index_price,
       funding_rate,open_interest,regime,feed_quality,derivatives,order_flow)
      VALUES($1,'BYBIT-BTCUSDT',100000,99999,100001,100000,100000,0.0001,1000000,
       $2::jsonb,$3::jsonb,$4::jsonb,$5::jsonb)`, [
      marketAt,
      JSON.stringify({ direction: 'range', volatility: 'normal' }),
      JSON.stringify({ healthy: true, spreadBps: 0.2 }),
      JSON.stringify({ fundingRate: 0.0001 }),
      JSON.stringify({ bookFragility: 0.1 }),
    ]);

    const report: any = await buildBtcTradeReport(1);
    const trade = report.trades.find((row: any) => row.callId === callId);
    assert.ok(trade, 'fixture trade is missing from the BTC report');
    assert.equal(trade.sourceCandidate.candidateId, candidateId);
    assert.equal(trade.sourceRiskDecision.approved, true);
    assert.equal(trade.events.length, 1);
    assert.equal(trade.fills.length, 1);
    assert.equal(trade.pnlPath.length, 1);
    assert.equal(trade.entryMarketSnapshot.referenceVenue, 'BYBIT-BTCUSDT');
    assert.equal(trade.features.integrationFixture, undefined);
    assert.equal(trade.sourceCandidate.features.integrationFixture, true);
  } finally {
    await pool!.query('DELETE FROM btc_pnl_snapshots WHERE call_id=$1', [callId]);
    await pool!.query('DELETE FROM btc_fills WHERE call_id=$1', [callId]);
    await pool!.query('DELETE FROM btc_call_events WHERE call_id=$1', [callId]);
    await pool!.query('DELETE FROM btc_paper_calls WHERE call_id=$1', [callId]);
    await pool!.query('DELETE FROM btc_risk_decisions WHERE candidate_id=$1', [candidateId]);
    await pool!.query('DELETE FROM btc_signal_candidates WHERE candidate_id=$1', [candidateId]);
    await pool!.query('DELETE FROM btc_market_snapshots WHERE snapshot_at=$1', [marketAt]);
    await pool!.query('DELETE FROM btc_strategy_versions WHERE strategy_id=$1 AND strategy_version=$2', [strategyId, strategyVersion]);
    await pool!.query('DELETE FROM btc_strategy_definitions WHERE strategy_id=$1', [strategyId]);
  }
});
