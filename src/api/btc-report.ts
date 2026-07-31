import { pool } from '../db';
import { getBtcStatus } from '../btc/bridge';

const terminalStatuses = ['won', 'lost', 'closed', 'liquidated', 'missed', 'cancelled'];

const number = (value: unknown, fallback = 0): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const nullableNumber = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const iso = (value: unknown): string | null => {
  if (!value) return null;
  const parsed = new Date(value as string | number | Date);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
};

const jsonObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

const jsonArray = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

function groupByCall(rows: any[]): Map<string, any[]> {
  const grouped = new Map<string, any[]>();
  for (const row of rows) {
    const id = String(row.call_id || '');
    if (!id) continue;
    const existing = grouped.get(id) || [];
    existing.push(row);
    grouped.set(id, existing);
  }
  return grouped;
}

function mapEvent(row: any) {
  return {
    eventId: number(row.event_id),
    type: String(row.event_type || ''),
    at: iso(row.event_at),
    price: nullableNumber(row.price),
    reason: String(row.reason || ''),
    realizedPnlDeltaUsd: number(row.realized_pnl_delta_usd),
    snapshot: jsonObject(row.snapshot),
  };
}

function mapFill(row: any) {
  return {
    fillId: number(row.fill_id),
    at: iso(row.fill_at),
    side: String(row.side || ''),
    purpose: String(row.purpose || ''),
    price: number(row.price),
    notionalUsd: number(row.notional_usd),
    fraction: number(row.fraction),
    feeUsd: number(row.fee_usd),
    slippageUsd: number(row.slippage_usd),
    metadata: jsonObject(row.metadata),
  };
}

function mapPnlSnapshot(row: any) {
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
}

function mapTrade(row: any, events: any[], fills: any[], snapshots: any[], entryMarket: any | undefined) {
  const openedAt = iso(row.opened_at);
  const closedAt = iso(row.closed_at);
  const holdingMinutes = openedAt && closedAt
    ? Math.max(0, (Date.parse(closedAt) - Date.parse(openedAt)) / 60_000)
    : null;
  const features = jsonObject(row.features);
  const grossPnlUsd = nullableNumber(features.grossPnlUsd);
  const projectedExitCostsUsd = nullableNumber(features.projectedExitCostsUsd);
  const totalModeledCostsUsd = nullableNumber(features.totalModeledCostsUsd);
  return {
    callId: String(row.call_id),
    book: String(row.book),
    strategy: {
      id: String(row.strategy_id),
      version: String(row.strategy_version),
      name: String(row.strategy_name),
      supportingStrategies: jsonArray(row.supporting_strategies),
    },
    direction: String(row.direction),
    status: String(row.status),
    timing: {
      openedAt,
      closedAt,
      holdingMinutes,
      entryAlertAt: iso(row.entry_alert_at),
      simulatedFillAt: iso(row.simulated_fill_at),
      updatedAt: iso(row.updated_at),
    },
    sizing: {
      marginUsd: number(row.margin_usd),
      leverage: number(row.leverage),
      notionalUsd: number(row.notional_usd),
      remainingFraction: number(row.remaining_fraction, 1),
    },
    prices: {
      entry: number(row.entry_price),
      current: number(row.current_price),
      stop: number(row.stop_price),
      trailingStop: nullableNumber(row.trailing_stop_price),
      target: number(row.target_price),
      extendedTarget: nullableNumber(row.extended_target_price),
      liquidation: number(row.liquidation_price),
      exit: nullableNumber(row.exit_price),
    },
    result: {
      exitReason: row.exit_reason || null,
      realizedPnlUsd: number(row.realized_pnl_usd),
      unrealizedPnlUsd: number(row.unrealized_pnl_usd),
      netPnlUsd: number(row.net_pnl_usd),
      grossPnlUsd,
      feesUsd: number(row.fees_usd),
      projectedExitCostsUsd,
      totalModeledCostsUsd,
      fundingUsd: number(row.funding_usd),
      roiPct: number(row.roi_pct),
      currentR: number(row.current_r),
      resultR: nullableNumber(row.result_r),
      maxFavorableR: number(row.max_favorable_r),
      maxAdverseR: number(row.max_adverse_r),
      grossMfePct: nullableNumber(features.grossMfePct),
      grossMaePct: nullableNumber(features.grossMaePct),
      runnerActivated: !!row.runner_activated,
    },
    confidence: number(row.confidence),
    rationale: jsonArray(row.rationale),
    features,
    sourceCandidate: row.linked_candidate_id ? {
      candidateId: String(row.linked_candidate_id),
      setupType: row.candidate_setup_type || null,
      mode: row.candidate_mode || null,
      createdAt: iso(row.candidate_created_at),
      expiresAt: iso(row.candidate_expires_at),
      entryMethod: row.candidate_entry_method || null,
      preferredEntry: nullableNumber(row.candidate_preferred_entry),
      entryZoneLow: nullableNumber(row.candidate_entry_zone_low),
      entryZoneHigh: nullableNumber(row.candidate_entry_zone_high),
      doNotChasePrice: nullableNumber(row.candidate_do_not_chase_price),
      structuralStop: nullableNumber(row.candidate_structural_stop),
      initialTarget: nullableNumber(row.candidate_initial_target),
      extendedTarget: nullableNumber(row.candidate_extended_target),
      maximumRealisticTarget: nullableNumber(row.candidate_maximum_realistic_target),
      scores: jsonObject(row.candidate_scores),
      rationale: jsonArray(row.candidate_rationale),
      features: jsonObject(row.candidate_features),
      decisionStatus: row.candidate_decision_status || null,
      decisionReason: row.candidate_decision_reason || null,
    } : null,
    sourceRiskDecision: row.risk_decision_id ? {
      decisionId: number(row.risk_decision_id),
      approved: !!row.risk_approved,
      reasons: jsonArray(row.risk_reasons),
      leverage: number(row.risk_leverage),
      notionalUsd: number(row.risk_notional_usd),
      entryPrice: nullableNumber(row.risk_entry_price),
      stopPrice: nullableNumber(row.risk_stop_price),
      targetPrice: nullableNumber(row.risk_target_price),
      liquidationPrice: nullableNumber(row.risk_liquidation_price),
      liquidationBufferPct: nullableNumber(row.risk_liquidation_buffer_pct),
      estimatedRiskUsd: number(row.risk_estimated_risk_usd),
      estimatedRewardUsd: number(row.risk_estimated_reward_usd),
      estimatedNetRR: number(row.risk_estimated_net_rr),
      estimatedTargetRoiPct: number(row.risk_estimated_target_roi_pct),
      estimatedCosts: jsonObject(row.risk_estimated_costs),
      createdAt: iso(row.risk_created_at),
    } : null,
    entryMarketSnapshot: entryMarket ? {
      at: iso(entryMarket.snapshot_at),
      referenceVenue: entryMarket.reference_venue || null,
      lastPrice: nullableNumber(entryMarket.last_price),
      bidPrice: nullableNumber(entryMarket.bid_price),
      askPrice: nullableNumber(entryMarket.ask_price),
      markPrice: nullableNumber(entryMarket.mark_price),
      indexPrice: nullableNumber(entryMarket.index_price),
      fundingRate: nullableNumber(entryMarket.funding_rate),
      openInterest: nullableNumber(entryMarket.open_interest),
      regime: jsonObject(entryMarket.regime),
      feedQuality: jsonObject(entryMarket.feed_quality),
      derivatives: jsonObject(entryMarket.derivatives),
      orderFlow: jsonObject(entryMarket.order_flow),
    } : null,
    events: events.map(mapEvent),
    fills: fills.map(mapFill),
    pnlPath: snapshots.map(mapPnlSnapshot),
  };
}

export async function buildBtcTradeReport(days = 3650): Promise<Record<string, unknown>> {
  const boundedDays = Math.max(1, Math.min(3650, Math.floor(days) || 3650));
  const generatedAt = new Date().toISOString();
  const liveStatus = await getBtcStatus().catch(error => ({
    engineState: 'unavailable',
    blockers: [`BTC status unavailable while building report: ${(error as Error).message}`],
  }));

  const base = {
    reportType: 'btc_strategy_trade_review',
    reportVersion: 1,
    generatedAt,
    scope: { days: boundedDays, allTimeRequested: boundedDays === 3650 },
    market: 'BTC-PERP',
    paperOnly: true,
    executionEnabled: false,
    signsOrBroadcastsTransactions: false,
    liveStatus,
  };
  if (!pool) return { ...base, error: 'PostgreSQL is not attached; no persistent BTC trade ledger is available.' };

  const cutoffSql = `now() - make_interval(days => $1::int)`;
  const [
    tradeRows,
    eventRows,
    fillRows,
    pnlRows,
    entryMarketRows,
    strategyRows,
    versionRows,
    funnelRows,
    rejectionRows,
    overlapRows,
    deliveryRows,
  ] = await Promise.all([
    pool.query(`SELECT p.*,
      c.candidate_id linked_candidate_id,c.setup_type candidate_setup_type,c.mode candidate_mode,
      c.created_at candidate_created_at,c.expires_at candidate_expires_at,c.entry_method candidate_entry_method,
      c.preferred_entry candidate_preferred_entry,c.entry_zone_low candidate_entry_zone_low,
      c.entry_zone_high candidate_entry_zone_high,c.do_not_chase_price candidate_do_not_chase_price,
      c.structural_stop candidate_structural_stop,c.initial_target candidate_initial_target,
      c.extended_target candidate_extended_target,c.maximum_realistic_target candidate_maximum_realistic_target,
      c.scores candidate_scores,c.rationale candidate_rationale,c.features candidate_features,
      c.decision_status candidate_decision_status,c.decision_reason candidate_decision_reason,
      r.decision_id risk_decision_id,r.approved risk_approved,r.reasons risk_reasons,
      r.leverage risk_leverage,r.notional_usd risk_notional_usd,r.entry_price risk_entry_price,
      r.stop_price risk_stop_price,r.target_price risk_target_price,r.liquidation_price risk_liquidation_price,
      r.liquidation_buffer_pct risk_liquidation_buffer_pct,r.estimated_risk_usd risk_estimated_risk_usd,
      r.estimated_reward_usd risk_estimated_reward_usd,r.estimated_net_rr risk_estimated_net_rr,
      r.estimated_target_roi_pct risk_estimated_target_roi_pct,r.estimated_costs risk_estimated_costs,
      r.created_at risk_created_at
      FROM btc_paper_calls p
      LEFT JOIN LATERAL (
        SELECT candidate.* FROM btc_signal_candidates candidate
         WHERE candidate.strategy_id=p.strategy_id
           AND candidate.strategy_version=p.strategy_version
           AND candidate.direction=p.direction
           AND candidate.created_at BETWEEN p.opened_at - interval '6 hours' AND p.opened_at + interval '2 minutes'
         ORDER BY ABS(EXTRACT(EPOCH FROM (p.opened_at-candidate.created_at))) ASC
         LIMIT 1
      ) c ON TRUE
      LEFT JOIN LATERAL (
        SELECT decision.* FROM btc_risk_decisions decision
         WHERE decision.candidate_id=c.candidate_id AND decision.book=p.book
         ORDER BY decision.created_at DESC LIMIT 1
      ) r ON TRUE
      WHERE p.opened_at >= ${cutoffSql}
      ORDER BY p.opened_at DESC`, [boundedDays]),
    pool.query(`SELECT event.* FROM btc_call_events event
      JOIN btc_paper_calls call ON call.call_id=event.call_id
      WHERE call.opened_at >= ${cutoffSql}
      ORDER BY event.call_id,event.event_at,event.event_id`, [boundedDays]),
    pool.query(`SELECT fill.* FROM btc_fills fill
      JOIN btc_paper_calls call ON call.call_id=fill.call_id
      WHERE call.opened_at >= ${cutoffSql}
      ORDER BY fill.call_id,fill.fill_at,fill.fill_id`, [boundedDays]),
    pool.query(`SELECT snapshot.* FROM btc_pnl_snapshots snapshot
      JOIN btc_paper_calls call ON call.call_id=snapshot.call_id
      WHERE call.opened_at >= ${cutoffSql}
      ORDER BY snapshot.call_id,snapshot.snapshot_at`, [boundedDays]),
    pool.query(`SELECT call.call_id,market.* FROM btc_paper_calls call
      LEFT JOIN LATERAL (
        SELECT snapshot.* FROM btc_market_snapshots snapshot
         WHERE snapshot.snapshot_at <= call.opened_at
         ORDER BY snapshot.snapshot_at DESC LIMIT 1
      ) market ON TRUE
      WHERE call.opened_at >= ${cutoffSql}`, [boundedDays]),
    pool.query(`SELECT strategy_id,strategy_version,strategy_name,book,
      COUNT(*)::int calls,
      COUNT(*) FILTER (WHERE status IN ('won','lost','closed','liquidated'))::int resolved,
      COUNT(*) FILTER (WHERE status='won')::int wins,
      COUNT(*) FILTER (WHERE status IN ('lost','liquidated'))::int losses,
      COUNT(*) FILTER (WHERE status='closed')::int scratches,
      COALESCE(SUM(net_pnl_usd),0) net_pnl_usd,
      AVG(result_r) FILTER (WHERE result_r IS NOT NULL) average_r,
      COALESCE(SUM(net_pnl_usd) FILTER (WHERE net_pnl_usd>0),0) gross_profit_usd,
      ABS(COALESCE(SUM(net_pnl_usd) FILTER (WHERE net_pnl_usd<0),0)) gross_loss_usd,
      AVG(leverage) average_leverage,
      AVG((features->>'costToGrossRiskPct')::double precision)
        FILTER (WHERE features ? 'costToGrossRiskPct' AND (features->>'costToGrossRiskPct') <> '') average_cost_to_gross_risk_pct,
      AVG((features->>'grossMfePct')::double precision)
        FILTER (WHERE features ? 'grossMfePct' AND (features->>'grossMfePct') <> '') average_gross_mfe_pct,
      AVG((features->>'grossMaePct')::double precision)
        FILTER (WHERE features ? 'grossMaePct' AND (features->>'grossMaePct') <> '') average_gross_mae_pct
      FROM btc_paper_calls
      WHERE opened_at >= ${cutoffSql}
      GROUP BY strategy_id,strategy_version,strategy_name,book
      ORDER BY strategy_id,strategy_version,book`, [boundedDays]),
    pool.query(`SELECT definition.strategy_id,definition.strategy_name,definition.description,definition.mode,
      version.strategy_version,version.leverage_cap,version.configuration,version.code_fingerprint,
      version.activated_at,version.retired_at
      FROM btc_strategy_definitions definition
      JOIN btc_strategy_versions version USING(strategy_id)
      ORDER BY definition.strategy_id,version.activated_at,version.strategy_version`),
    pool.query(`SELECT strategy_id,strategy_version,mode,decision_status,COUNT(*)::int candidates
      FROM btc_signal_candidates
      WHERE created_at >= ${cutoffSql}
      GROUP BY strategy_id,strategy_version,mode,decision_status
      ORDER BY strategy_id,strategy_version,mode,decision_status`, [boundedDays]),
    pool.query(`SELECT candidate.strategy_id,candidate.strategy_version,decision.book,
      reason.value reason,COUNT(*)::int occurrences
      FROM btc_risk_decisions decision
      JOIN btc_signal_candidates candidate ON candidate.candidate_id=decision.candidate_id
      CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(decision.reasons,'[]'::jsonb)) reason(value)
      WHERE decision.created_at >= ${cutoffSql}
      GROUP BY candidate.strategy_id,candidate.strategy_version,decision.book,reason.value
      ORDER BY occurrences DESC,candidate.strategy_id,candidate.strategy_version`, [boundedDays]),
    pool.query(`SELECT first.call_id first_call_id,second.call_id second_call_id,
      first.strategy_id first_strategy_id,first.strategy_version first_strategy_version,
      second.strategy_id second_strategy_id,second.strategy_version second_strategy_version,
      first.book first_book,second.book second_book,first.direction first_direction,second.direction second_direction,
      first.opened_at first_opened_at,second.opened_at second_opened_at,
      EXTRACT(EPOCH FROM (second.opened_at-first.opened_at))/60 minutes_between_entries,
      CASE WHEN first.direction=second.direction THEN 'same_direction' ELSE 'opposite_direction' END relationship
      FROM btc_paper_calls first
      JOIN btc_paper_calls second ON first.call_id<second.call_id
       AND first.opened_at < COALESCE(second.closed_at,now())
       AND second.opened_at < COALESCE(first.closed_at,now())
      WHERE first.opened_at >= ${cutoffSql} AND second.opened_at >= ${cutoffSql}
      ORDER BY GREATEST(first.opened_at,second.opened_at) DESC LIMIT 2000`, [boundedDays]),
    pool.query(`SELECT delivery.* FROM btc_alert_deliveries delivery
      LEFT JOIN btc_paper_calls call ON call.call_id=delivery.call_id
      WHERE COALESCE(call.opened_at,delivery.created_at) >= ${cutoffSql}
      ORDER BY delivery.created_at DESC`, [boundedDays]),
  ]);

  const events = groupByCall(eventRows.rows);
  const fills = groupByCall(fillRows.rows);
  const snapshots = groupByCall(pnlRows.rows);
  const entryMarkets = new Map(entryMarketRows.rows.map(row => [String(row.call_id), row]));
  const trades = tradeRows.rows.map(row => mapTrade(
    row,
    events.get(String(row.call_id)) || [],
    fills.get(String(row.call_id)) || [],
    snapshots.get(String(row.call_id)) || [],
    entryMarkets.get(String(row.call_id)),
  ));

  const resolved = trades.filter(trade => terminalStatuses.includes(String(trade.status)));
  const wins = resolved.filter(trade => trade.status === 'won').length;
  const losses = resolved.filter(trade => trade.status === 'lost' || trade.status === 'liquidated').length;
  const netPnlUsd = trades.reduce((sum, trade) => sum + number((trade as any).result.netPnlUsd), 0);

  return {
    ...base,
    summary: {
      calls: trades.length,
      resolved: resolved.length,
      wins,
      losses,
      winRatePct: wins + losses ? wins / (wins + losses) * 100 : null,
      active: trades.length - resolved.length,
      netPnlUsd,
      actionableCalls: trades.filter(trade => trade.book === 'actionable').length,
      researchCalls: trades.filter(trade => trade.book === 'research').length,
      firstTradeAt: trades.length ? trades.at(-1)?.timing.openedAt : null,
      latestTradeAt: trades[0]?.timing.openedAt || null,
    },
    strategyVersions: versionRows.rows,
    strategyPerformance: strategyRows.rows.map(row => ({
      ...row,
      profit_factor: number(row.gross_loss_usd) > 0 ? number(row.gross_profit_usd) / number(row.gross_loss_usd) : null,
    })),
    candidateFunnel: funnelRows.rows,
    riskRejectionReasons: rejectionRows.rows,
    overlappingExposure: overlapRows.rows,
    alertDeliveries: deliveryRows.rows,
    trades,
    fieldGuide: {
      sourceOfTruth: 'btc_paper_calls plus append-only btc_call_events, btc_fills, and btc_pnl_snapshots',
      pAndL: 'net P&L uses executable bid/ask fills, charged fees/slippage, projected closing costs while open, and funding',
      mfeMae: 'maxFavorableR/maxAdverseR are net R paths; grossMfePct/grossMaePct are directional executable-price paths before converting to R',
      linkedCandidate: 'sourceCandidate is the nearest preceding candidate for the same strategy version and direction within the candidate lifetime window',
      linkedRiskDecision: 'sourceRiskDecision is the final decision for that linked candidate and trade book',
      entryMarketTelemetry: 'newer calls store entry regime, feed, order-flow, derivatives, and cross-venue scalars in features; older cohorts may have partial telemetry',
      immutableCohorts: 'strategy versions must be analyzed separately; old losing versions remain in this report and are never rewritten',
    },
  };
}
