import fs from 'node:fs';

function replaceOnce(path, before, after) {
  const source = fs.readFileSync(path, 'utf8');
  const matches = source.split(before).length - 1;
  if (matches !== 1) throw new Error(`${path}: expected one replacement target, found ${matches}`);
  fs.writeFileSync(path, source.replace(before, after));
}

replaceOnce('src/btc/platform/execution.ts', `export interface ExecutionEvent {
  type: ExecutionEventType;
  call: PaperCall;
  price: number;
  timestamp: number;
  reason: string;
  realizedPnlDeltaUsd: number;
}`, `export interface ExecutionFill {
  side: 'buy' | 'sell';
  purpose: 'entry' | 'partial_exit' | 'exit' | 'liquidation';
  price: number;
  notionalUsd: number;
  fraction: number;
  feeUsd: number;
  slippageUsd: number;
  metadata: Record<string, unknown>;
}

export interface ExecutionEvent {
  type: ExecutionEventType;
  call: PaperCall;
  price: number;
  timestamp: number;
  reason: string;
  realizedPnlDeltaUsd: number;
  fill?: ExecutionFill;
}`);

replaceOnce('src/btc/platform/execution.ts', `function exitCosts(notional: number, context: MarketContext, emergency = false): number {
  const spreadBps = Math.max(0, context.feed.spreadBps ?? 4);
  const fragility = clamp(context.orderFlow.bookFragility, 0, 1);
  const slippageBps = (emergency ? 2.5 : 0.8) + spreadBps * 0.45 + fragility * (emergency ? 8 : 4);
  return notional * (DEFAULT_COST_MODEL.takerFeeRate + slippageBps / 10_000);
}`, `interface ExitCostBreakdown {
  totalUsd: number;
  feeUsd: number;
  slippageUsd: number;
  slippageBps: number;
}

function exitCostBreakdown(notional: number, context: MarketContext, emergency = false): ExitCostBreakdown {
  const spreadBps = Math.max(0, context.feed.spreadBps ?? 4);
  const fragility = clamp(context.orderFlow.bookFragility, 0, 1);
  const slippageBps = (emergency ? 2.5 : 0.8) + spreadBps * 0.45 + fragility * (emergency ? 8 : 4);
  const feeUsd = notional * DEFAULT_COST_MODEL.takerFeeRate;
  const slippageUsd = notional * slippageBps / 10_000;
  return { totalUsd: feeUsd + slippageUsd, feeUsd, slippageUsd, slippageBps };
}`);

replaceOnce('src/btc/platform/execution.ts', `  const projectedExitCostsUsd = exitCosts(remainingNotional, context);`, `  const projectedExitCostsUsd = exitCostBreakdown(remainingNotional, context).totalUsd;`);

replaceOnce('src/btc/platform/execution.ts', `function closeFraction(
  call: PaperCall,
  context: MarketContext,
  price: number,
  fraction: number,
  emergency = false,
): number {
  const closeFraction = clamp(fraction, 0, call.remainingFraction);
  const notionalClosed = call.notionalUsd * closeFraction;
  const gross = notionalClosed * directionalMove(call.direction, call.entryPrice, price);
  const costs = exitCosts(notionalClosed, context, emergency);
  const net = gross - costs;
  call.realizedPnlUsd += net;
  call.feesUsd += costs;
  call.remainingFraction = Math.max(0, call.remainingFraction - closeFraction);
  return net;
}`, `interface ClosedFraction {
  netUsd: number;
  grossUsd: number;
  notionalUsd: number;
  fraction: number;
  feeUsd: number;
  slippageUsd: number;
}

function closeFraction(
  call: PaperCall,
  context: MarketContext,
  price: number,
  fraction: number,
  emergency = false,
): ClosedFraction {
  const fractionClosed = clamp(fraction, 0, call.remainingFraction);
  const notionalClosed = call.notionalUsd * fractionClosed;
  const grossUsd = notionalClosed * directionalMove(call.direction, call.entryPrice, price);
  const costs = exitCostBreakdown(notionalClosed, context, emergency);
  const netUsd = grossUsd - costs.totalUsd;
  call.realizedPnlUsd += netUsd;
  call.feesUsd += costs.totalUsd;
  call.remainingFraction = Math.max(0, call.remainingFraction - fractionClosed);
  return {
    netUsd,
    grossUsd,
    notionalUsd: notionalClosed,
    fraction: fractionClosed,
    feeUsd: costs.feeUsd,
    slippageUsd: costs.slippageUsd,
  };
}`);

replaceOnce('src/btc/platform/execution.ts', `    event: {
      type: 'entry_filled', call, price: fill, timestamp: context.timestamp,
      reason: \`${'${book}'} paper entry filled after risk approval\`, realizedPnlDeltaUsd: -initialCosts,
    },`, `    event: {
      type: 'entry_filled', call, price: fill, timestamp: context.timestamp,
      reason: \`${'${book}'} paper entry filled after risk approval\`, realizedPnlDeltaUsd: -initialCosts,
      fill: {
        side: candidate.direction === 'long' ? 'buy' : 'sell',
        purpose: 'entry',
        price: fill,
        notionalUsd: plan.notionalUsd,
        fraction: 1,
        feeUsd: plan.costs.entryFeeUsd,
        slippageUsd: plan.costs.entrySlippageUsd,
        metadata: {
          book,
          candidateId: candidate.id,
          strategyId: candidate.strategyId,
          strategyVersion: candidate.strategyVersion,
          referenceVenue: context.feed.referenceVenue,
          plannedEntryPrice: plan.entryPrice,
        },
      },
    },`);

replaceOnce('src/btc/platform/execution.ts', `  const delta = closeFraction(call, context, price, call.remainingFraction, liquidated || reason.includes('emergency'));`, `  const closed = closeFraction(call, context, price, call.remainingFraction, liquidated || reason.includes('emergency'));`);

replaceOnce('src/btc/platform/execution.ts', `    reason,
    realizedPnlDeltaUsd: delta + call.fundingUsd,
  };`, `    reason,
    realizedPnlDeltaUsd: closed.netUsd + call.fundingUsd,
    fill: {
      side: call.direction === 'long' ? 'sell' : 'buy',
      purpose: liquidated ? 'liquidation' : 'exit',
      price,
      notionalUsd: closed.notionalUsd,
      fraction: closed.fraction,
      feeUsd: closed.feeUsd,
      slippageUsd: closed.slippageUsd,
      metadata: {
        book: call.book,
        strategyId: call.strategyId,
        strategyVersion: call.strategyVersion,
        reason,
        emergency: reason.includes('emergency'),
      },
    },
  };`);

replaceOnce('src/btc/platform/execution.ts', `    const delta = closeFraction(call, context, exit, 0.75);`, `    const closed = closeFraction(call, context, exit, 0.75);`);

replaceOnce('src/btc/platform/execution.ts', `      type: 'partial_take_profit', call, price: exit, timestamp: at,
      reason: '75% closed at the initial net target; 25% runner activated', realizedPnlDeltaUsd: delta,
    });`, `      type: 'partial_take_profit', call, price: exit, timestamp: at,
      reason: '75% closed at the initial net target; 25% runner activated', realizedPnlDeltaUsd: closed.netUsd,
      fill: {
        side: call.direction === 'long' ? 'sell' : 'buy',
        purpose: 'partial_exit',
        price: exit,
        notionalUsd: closed.notionalUsd,
        fraction: closed.fraction,
        feeUsd: closed.feeUsd,
        slippageUsd: closed.slippageUsd,
        metadata: {
          book: call.book,
          strategyId: call.strategyId,
          strategyVersion: call.strategyVersion,
          runnerRemainingFraction: call.remainingFraction,
        },
      },
    });`);

replaceOnce('src/btc/platform/ledger.ts', `    max_favorable_r=$16,max_adverse_r=$17,remaining_fraction=$18,runner_activated=$19,
    trailing_stop_price=$20,fees_usd=$21,funding_usd=$22,updated_at=now() WHERE call_id=$1`, `    max_favorable_r=$16,max_adverse_r=$17,remaining_fraction=$18,runner_activated=$19,
    trailing_stop_price=$20,fees_usd=$21,funding_usd=$22,features=$23::jsonb,updated_at=now() WHERE call_id=$1`);

replaceOnce('src/btc/platform/ledger.ts', `    call.trailingStopPrice, call.feesUsd, call.fundingUsd,
  ]);`, `    call.trailingStopPrice, call.feesUsd, call.fundingUsd, JSON.stringify(call.features),
  ]);`);

replaceOnce('src/btc/platform/ledger.ts', `      trailingStopPrice: event.call.trailingStopPrice,
    }),
  ]);
  if (event.type === 'pnl_snapshot') {`, `      trailingStopPrice: event.call.trailingStopPrice,
      maxFavorableR: event.call.maxFavorableR,
      maxAdverseR: event.call.maxAdverseR,
      feesUsd: event.call.feesUsd,
      fundingUsd: event.call.fundingUsd,
      grossPnlUsd: event.call.features.grossPnlUsd ?? null,
      grossMfePct: event.call.features.grossMfePct ?? null,
      grossMaePct: event.call.features.grossMaePct ?? null,
      totalModeledCostsUsd: event.call.features.totalModeledCostsUsd ?? null,
    }),
  ]);
  if (event.fill) {
    await pool.query(\`INSERT INTO btc_fills
      (call_id,fill_at,side,purpose,price,notional_usd,fraction,fee_usd,slippage_usd,metadata)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)\`, [
      event.call.id, toDate(event.timestamp), event.fill.side, event.fill.purpose,
      event.fill.price, event.fill.notionalUsd, event.fill.fraction,
      event.fill.feeUsd, event.fill.slippageUsd, JSON.stringify(event.fill.metadata),
    ]);
  }
  if (event.type === 'pnl_snapshot') {`);

replaceOnce('src/btc/platform/engine.ts', `  private strategyHasActiveResearch(strategyId: string): boolean {
    return this.activeCalls.some(call => call.book === 'research' && call.strategyId === strategyId && activeStates.has(call.status));
  }`, `  private strategyHasResearchExposure(strategyId: string): boolean {
    const active = this.activeCalls.some(call => call.book === 'research'
      && call.strategyId === strategyId && activeStates.has(call.status));
    const armed = [...this.armed.values()].some(item => item.book === 'research'
      && item.candidate.strategyId === strategyId);
    return active || armed;
  }`);

replaceOnce('src/btc/platform/engine.ts', `  private hasResearchExposure(): boolean {
    const active = this.activeCalls.some(call => call.book === 'research' && activeStates.has(call.status));
    const armed = [...this.armed.values()].some(item => item.book === 'research');
    return active || armed;
  }`, `  private researchCapacityReason(candidate: StrategyCandidate): string | null {
    const active = this.activeCalls
      .filter(call => call.book === 'research' && activeStates.has(call.status))
      .map(call => ({ direction: call.direction }));
    const armed = [...this.armed.values()]
      .filter(item => item.book === 'research')
      .map(item => ({ direction: item.candidate.direction }));
    const exposures = [...active, ...armed];
    const configured = Number(process.env.BTC_MAX_ACTIVE_RESEARCH_CALLS || 4);
    const maxGlobal = Number.isFinite(configured) ? Math.max(1, Math.min(8, Math.floor(configured))) : 4;
    if (exposures.length >= maxGlobal) {
      return \`research concurrency cap of ${'${maxGlobal}'} active or armed calls is reached\`;
    }
    const maxPerDirection = Math.max(1, Math.ceil(maxGlobal / 2));
    const sameDirection = exposures.filter(item => item.direction === candidate.direction).length;
    if (sameDirection >= maxPerDirection) {
      return \`research ${'${candidate.direction}'}-direction cap of ${'${maxPerDirection}'} is reached\`;
    }
    return null;
  }`);

replaceOnce('src/btc/platform/engine.ts', `    if (this.hasResearchExposure()) {
      await persistRiskDecision(candidate, 'research', plan, ['global research exposure is already active or armed']);
      return false;
    }
    if (this.strategyHasActiveResearch(candidate.strategyId)) {
      await persistRiskDecision(candidate, 'research', plan, ['research strategy already has an active call']);
      return false;
    }`, `    if (this.strategyHasResearchExposure(candidate.strategyId)) {
      await persistRiskDecision(candidate, 'research', plan, ['research strategy already has an active or armed call']);
      return false;
    }
    const capacityReason = this.researchCapacityReason(candidate);
    if (capacityReason) {
      await persistRiskDecision(candidate, 'research', plan, [capacityReason]);
      return false;
    }`);

replaceOnce('src/btc/platform/engine.ts', `    await persistRiskDecision(candidate, 'actionable', plan, assessment.reasons);
    if (!assessment.approved || this.strategyCooldownActive(candidate)) return;`, `    const cooldownActive = this.strategyCooldownActive(candidate);
    await persistRiskDecision(candidate, 'actionable', plan, [
      ...assessment.reasons,
      ...(cooldownActive ? ['strategy cooldown is active'] : []),
    ]);
    if (!assessment.approved || cooldownActive) return;`);

replaceOnce('src/btc/platform/engine.ts', `    let selectedResearch = false;
    for (const item of researchPool) {
      if (!item.researchPlan.approved) {
        await persistRiskDecision(item.candidate, 'research', item.researchPlan, item.researchPlan.rejectionReasons);
        continue;
      }
      if (!selectedResearch && !this.hasResearchExposure()) {
        selectedResearch = await this.armResearch(item.candidate, item.researchPlan);
        if (selectedResearch) continue;
      }
      await persistRiskDecision(item.candidate, 'research', item.researchPlan, [
        'not selected by global research event coordinator; correlated market exposure already selected',
      ]);
    }`, `    for (const item of researchPool) {
      if (!item.researchPlan.approved) {
        await persistRiskDecision(item.candidate, 'research', item.researchPlan, item.researchPlan.rejectionReasons);
        continue;
      }
      await this.armResearch(item.candidate, item.researchPlan);
    }`);

replaceOnce('src/api/btc-report.ts', `function mapPnlSnapshot(row: any) {
  return {
    at: iso(row.snapshot_at),
    markPrice: number(row.mark_price),
    executableExitPrice: number(row.executable_exit_price),
    realizedPnlUsd: number(row.realized_pnl_usd),
    unrealizedPnlUsd: number(row.unrealized_pnl_usd),
    netPnlUsd: number(row.net_pnl_usd),
    roiPct: number(row.roi_pct),
    currentR: number(row.current_r),
    liquidationBufferPct: number(row.liquidation_buffer_pct),
  };
}`, `function mapPnlSnapshot(row: any) {
  return {
    at: iso(row.snapshot_at),
    markPrice: number(row.mark_price),
    executableExitPrice: number(row.executable_exit_price),
    realizedPnlUsd: number(row.realized_pnl_usd),
    unrealizedPnlUsd: number(row.unrealized_pnl_usd),
    netPnlUsd: number(row.net_pnl_usd),
    roiPct: number(row.roi_pct),
    currentR: number(row.current_r),
    liquidationBufferPct: number(row.liquidation_buffer_pct),
    marketContext: row.market_snapshot_at ? {
      at: iso(row.market_snapshot_at),
      referenceVenue: row.market_reference_venue || null,
      lastPrice: nullableNumber(row.market_last_price),
      bidPrice: nullableNumber(row.market_bid_price),
      askPrice: nullableNumber(row.market_ask_price),
      markPrice: nullableNumber(row.market_mark_price),
      indexPrice: nullableNumber(row.market_index_price),
      fundingRate: nullableNumber(row.market_funding_rate),
      openInterest: nullableNumber(row.market_open_interest),
      regime: jsonObject(row.market_regime),
      feedQuality: jsonObject(row.market_feed_quality),
      derivatives: jsonObject(row.market_derivatives),
      orderFlow: jsonObject(row.market_order_flow),
    } : null,
  };
}

function summarizeTradeCohort(trades: any[]) {
  const resolved = trades.filter(trade => ['won', 'lost', 'closed', 'liquidated'].includes(String(trade.status)));
  const active = trades.filter(trade => ['armed', 'open', 'partial'].includes(String(trade.status)));
  const wins = resolved.filter(trade => trade.status === 'won').length;
  const losses = resolved.filter(trade => trade.status === 'lost' || trade.status === 'liquidated').length;
  const resolvedNetPnlUsd = resolved.reduce((sum, trade) => sum + number(trade.result.netPnlUsd), 0);
  const activeNetPnlUsd = active.reduce((sum, trade) => sum + number(trade.result.netPnlUsd), 0);
  const modeledCostsUsd = resolved.reduce((sum, trade) => sum + number(trade.result.feesUsd), 0);
  const grossPnlBeforeCostsUsd = resolved.reduce((sum, trade) => (
    sum + number(trade.result.netPnlUsd) + number(trade.result.feesUsd) - number(trade.result.fundingUsd)
  ), 0);
  return {
    calls: trades.length,
    resolved: resolved.length,
    active: active.length,
    wins,
    losses,
    winRatePct: wins + losses ? wins / (wins + losses) * 100 : null,
    resolvedNetPnlUsd,
    activeNetPnlUsd,
    totalNetPnlUsd: resolvedNetPnlUsd + activeNetPnlUsd,
    grossPnlBeforeCostsUsd,
    modeledCostsUsd,
    costShareOfAbsoluteResolvedLossPct: resolvedNetPnlUsd < 0
      ? modeledCostsUsd / Math.abs(resolvedNetPnlUsd) * 100 : null,
  };
}

function diagnoseTrade(trade: any) {
  const entry = number(trade.prices.entry);
  const stopDistancePct = entry > 0 ? Math.abs(number(trade.prices.stop) - entry) / entry * 100 : 0;
  const targetDistancePct = entry > 0 ? Math.abs(number(trade.prices.target) - entry) / entry * 100 : 0;
  const moves = trade.pnlPath.map((snapshot: any) => {
    const exit = number(snapshot.executableExitPrice);
    return trade.direction === 'long' ? (exit - entry) / entry * 100 : (entry - exit) / entry * 100;
  });
  const grossMfePct = moves.length ? Math.max(...moves) : nullableNumber(trade.result.grossMfePct);
  const grossMaePct = moves.length ? Math.min(...moves) : nullableNumber(trade.result.grossMaePct);
  const grossRiskUsd = number(trade.sizing.notionalUsd) * stopDistancePct / 100;
  const feeToGrossRiskPct = grossRiskUsd > 0 ? number(trade.result.feesUsd) / grossRiskUsd * 100 : null;
  const targetProgressPct = targetDistancePct > 0 && grossMfePct !== null
    ? grossMfePct / targetDistancePct * 100 : null;
  const grossMfeR = stopDistancePct > 0 && grossMfePct !== null ? grossMfePct / stopDistancePct : null;
  const failureModes: string[] = [];
  const resolvedLoss = trade.status === 'lost' || trade.status === 'liquidated';
  if (resolvedLoss && feeToGrossRiskPct !== null && feeToGrossRiskPct >= 100) {
    failureModes.push('friction_exceeded_structural_risk');
  } else if (resolvedLoss && feeToGrossRiskPct !== null && feeToGrossRiskPct >= 50) {
    failureModes.push('friction_consumed_over_half_risk');
  }
  if (resolvedLoss && grossMfePct !== null && grossMfePct <= 0) failureModes.push('entry_never_moved_favorably');
  if (resolvedLoss && targetProgressPct !== null && targetProgressPct < 25) failureModes.push('target_path_probability_mismatch');
  if (resolvedLoss && grossMfeR !== null && grossMfeR >= 1) failureModes.push('gave_back_at_least_one_gross_r');
  if (trade.status === 'liquidated') failureModes.push('liquidation');
  if (String(trade.result.exitReason || '').includes('maximum holding')) failureModes.push('time_stop');
  if (String(trade.result.exitReason || '').includes('structural stop')) failureModes.push('structural_stop');
  if (String(trade.result.exitReason || '').includes('feed degradation')) failureModes.push('data_quality_exit');
  if (trade.status === 'won') failureModes.push('profitable');
  if (['armed', 'open', 'partial'].includes(String(trade.status))) failureModes.push('active_observation');
  return {
    grossMfePct,
    grossMaePct,
    grossMfeR,
    feeToGrossRiskPct,
    targetProgressPct,
    grossRiskUsd,
    grossFinalPnlBeforeCostsUsd: number(trade.result.netPnlUsd) + number(trade.result.feesUsd) - number(trade.result.fundingUsd),
    primaryFailure: failureModes[0] || null,
    failureModes,
  };
}`);

replaceOnce('src/api/btc-report.ts', `    pool.query(\`SELECT snapshot.* FROM btc_pnl_snapshots snapshot
      JOIN btc_paper_calls call ON call.call_id=snapshot.call_id
      WHERE call.opened_at >= ${'${cutoffSql}'}
      ORDER BY snapshot.call_id,snapshot.snapshot_at\`, [boundedDays]),`, `    pool.query(\`SELECT snapshot.*,
      market.snapshot_at market_snapshot_at,market.reference_venue market_reference_venue,
      market.last_price market_last_price,market.bid_price market_bid_price,market.ask_price market_ask_price,
      market.mark_price market_mark_price,market.index_price market_index_price,
      market.funding_rate market_funding_rate,market.open_interest market_open_interest,
      market.regime market_regime,market.feed_quality market_feed_quality,
      market.derivatives market_derivatives,market.order_flow market_order_flow
      FROM btc_pnl_snapshots snapshot
      JOIN btc_paper_calls call ON call.call_id=snapshot.call_id
      LEFT JOIN LATERAL (
        SELECT market.* FROM btc_market_snapshots market
         WHERE market.snapshot_at <= snapshot.snapshot_at
         ORDER BY market.snapshot_at DESC LIMIT 1
      ) market ON TRUE
      WHERE call.opened_at >= ${'${cutoffSql}'}
      ORDER BY snapshot.call_id,snapshot.snapshot_at\`, [boundedDays]),`);

replaceOnce('src/api/btc-report.ts', `  const trades = tradeRows.rows.map(row => mapTrade(
    row,
    events.get(String(row.call_id)) || [],
    fills.get(String(row.call_id)) || [],
    snapshots.get(String(row.call_id)) || [],
    entryMarkets.get(String(row.call_id)),
  ));`, `  const currentVersionKeys = new Set(
    (Array.isArray((liveStatus as any).strategies) ? (liveStatus as any).strategies : [])
      .map((strategy: any) => \`${'${strategy.strategyId}'}:${'${strategy.strategyVersion}'}\`),
  );
  const trades = tradeRows.rows.map(row => mapTrade(
    row,
    events.get(String(row.call_id)) || [],
    fills.get(String(row.call_id)) || [],
    snapshots.get(String(row.call_id)) || [],
    entryMarkets.get(String(row.call_id)),
  )).map((trade: any) => {
    const currentVersion = currentVersionKeys.has(\`${'${trade.strategy.id}'}:${'${trade.strategy.version}'}\`);
    return {
      ...trade,
      cohort: { currentVersion, label: currentVersion ? 'current_version' : 'legacy_version' },
      diagnostics: diagnoseTrade(trade),
    };
  });`);

replaceOnce('src/api/btc-report.ts', `  const netPnlUsd = trades.reduce((sum, trade) => sum + number((trade as any).result.netPnlUsd), 0);

  return {`, `  const netPnlUsd = trades.reduce((sum, trade) => sum + number((trade as any).result.netPnlUsd), 0);
  const currentVersionTrades = trades.filter((trade: any) => trade.cohort.currentVersion);
  const legacyVersionTrades = trades.filter((trade: any) => !trade.cohort.currentVersion);
  const failureModeCounts = trades
    .filter((trade: any) => ['won', 'lost', 'closed', 'liquidated'].includes(String(trade.status)))
    .flatMap((trade: any) => trade.diagnostics.failureModes)
    .reduce((counts: Record<string, number>, mode: string) => {
      counts[mode] = (counts[mode] || 0) + 1;
      return counts;
    }, {});

  return {`);

replaceOnce('src/api/btc-report.ts', `    strategyVersions: versionRows.rows,`, `    cohorts: {
      currentVersions: summarizeTradeCohort(currentVersionTrades),
      legacyVersions: summarizeTradeCohort(legacyVersionTrades),
    },
    failureModeCounts,
    strategyVersions: versionRows.rows,`);

replaceOnce('src/api/btc-report.ts', `      entryMarketTelemetry: 'newer calls store entry regime, feed, order-flow, derivatives, and cross-venue scalars in features; older cohorts may have partial telemetry',
      immutableCohorts: 'strategy versions must be analyzed separately; old losing versions remain in this report and are never rewritten',`, `      entryMarketTelemetry: 'newer calls store entry regime, feed, order-flow, derivatives, and cross-venue scalars in features; older cohorts may have partial telemetry',
      pathMarketTelemetry: 'each P&L snapshot is joined to the nearest preceding BTC market snapshot so regime, feed, derivatives, and order flow can be compared with the trade path',
      diagnostics: 'every trade includes gross MFE/MAE reconstructed from executable exits, friction versus structural risk, target progress, and explicit failure-mode labels',
      currentVsLegacy: 'cohorts.currentVersions only includes strategy ID/version pairs currently loaded by the engine; legacy losses remain available but are not evidence about the replacement logic',
      immutableCohorts: 'strategy versions must be analyzed separately; old losing versions remain in this report and are never rewritten',`);

replaceOnce('src/btc/platform/pnl.test.ts', `  const { call } = createPaperCall(candidate, plan, baseContext, 'actionable');
  near(call.realizedPnlUsd, -0.60, 'entry charged costs');`, `  const { call, event } = createPaperCall(candidate, plan, baseContext, 'actionable');
  near(call.realizedPnlUsd, -0.60, 'entry charged costs');
  assert.equal(event.fill?.purpose, 'entry');
  near(Number(event.fill?.feeUsd), 0.55, 'entry fill fee');
  near(Number(event.fill?.slippageUsd), 0.05, 'entry fill slippage');`);

replaceOnce('src/btc/platform/pnl.test.ts', `  markPaperCall(call, context);

  const gross = 1000 * (100.50 - 100.01) / 100.01;`, `  const events = markPaperCall(call, context);
  const partial = events.find(event => event.type === 'partial_take_profit');
  assert.equal(partial?.fill?.purpose, 'partial_exit');
  near(Number(partial?.fill?.fraction), 0.75, 'partial fill fraction');
  near(Number(partial?.fill?.notionalUsd), 750, 'partial fill notional');

  const gross = 1000 * (100.50 - 100.01) / 100.01;`);

replaceOnce('src/api/btc-report.integration.test.ts', `  insertCall,
  persistCandidate,`, `  appendCallEvent,
  insertCall,
  persistCandidate,`);

replaceOnce('src/api/btc-report.integration.test.ts', `  registerStrategies,
} from '../btc/platform/ledger';`, `  registerStrategies,
  updateCall,
} from '../btc/platform/ledger';`);

replaceOnce('src/api/btc-report.integration.test.ts', `  const marketAt = new Date(openedAt - 1_000);`, `  const marketAt = new Date(Math.floor(openedAt / 60_000) * 60_000 - 1_000);`);

replaceOnce('src/api/btc-report.integration.test.ts', `    await insertCall(call);
    await pool!.query(\`INSERT INTO btc_call_events
      (call_id,event_type,event_at,price,reason,realized_pnl_delta_usd,snapshot)
      VALUES($1,'position_closed',$2,$3,$4,$5,$6::jsonb)\`, [
      callId, new Date(closedAt), 99_500, 'integration structural stop', -3,
      JSON.stringify({ status: 'lost', currentR: -1 }),
    ]);
    await pool!.query(\`INSERT INTO btc_fills
      (call_id,fill_at,side,purpose,price,notional_usd,fraction,fee_usd,slippage_usd,metadata)
      VALUES($1,$2,'buy','entry',100000,500,1,0.25,0.05,$3::jsonb)\`, [
      callId, new Date(openedAt), JSON.stringify({ fixture: true }),
    ]);`, `    await insertCall(call);
    call.features.grossMfePct = 0.75;
    call.features.grossMaePct = -0.5;
    await updateCall(call);
    await appendCallEvent({
      type: 'position_closed',
      call,
      price: 99_500,
      timestamp: closedAt,
      reason: 'integration structural stop',
      realizedPnlDeltaUsd: -3,
      fill: {
        side: 'sell',
        purpose: 'exit',
        price: 99_500,
        notionalUsd: 500,
        fraction: 1,
        feeUsd: 0.25,
        slippageUsd: 0.05,
        metadata: { fixture: true },
      },
    });`);

replaceOnce('src/api/btc-report.integration.test.ts', `    assert.equal(trade.pnlPath.length, 1);
    assert.equal(trade.entryMarketSnapshot.referenceVenue, 'BYBIT-BTCUSDT');`, `    assert.equal(trade.pnlPath.length, 1);
    assert.equal(trade.pnlPath[0].marketContext.referenceVenue, 'BYBIT-BTCUSDT');
    assert.equal(trade.entryMarketSnapshot.referenceVenue, 'BYBIT-BTCUSDT');
    assert.equal(trade.features.grossMfePct, 0.75);
    assert.ok(Array.isArray(trade.diagnostics.failureModes));`);

console.log('Applied BTC profitability diagnostics, fill ledger, cohort reporting, and bounded research concurrency.');
