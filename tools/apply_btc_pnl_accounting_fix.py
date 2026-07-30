from pathlib import Path
import re


def replace_exact(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    if old not in text:
        raise SystemExit(f"missing expected text in {path}: {old[:180]!r}")
    file.write_text(text.replace(old, new, 1))


def replace_regex(path: str, pattern: str, replacement: str) -> None:
    file = Path(path)
    text = file.read_text()
    updated, count = re.subn(pattern, replacement, text, count=1, flags=re.S)
    if count != 1:
        raise SystemExit(f"expected one regex match in {path}, got {count}: {pattern[:180]!r}")
    file.write_text(updated)


execution = Path('src/btc/platform/execution.ts')
ledger = Path('src/btc/platform/ledger.ts')
if (
    execution.exists()
    and ledger.exists()
    and 'pnlAccountingVersion: 2' in execution.read_text()
    and 'export async function pnlLedgerSummary' in ledger.read_text()
    and Path('src/btc/platform/pnl.test.ts').exists()
):
    print('BTC PnL accounting fix already applied')
    raise SystemExit(0)

# --- Trade-level accounting -------------------------------------------------
replace_exact(
    'src/btc/platform/execution.ts',
    """function plannedRisk(call: PaperCall): number {
  const gross = call.notionalUsd * Math.abs(call.entryPrice - call.stopPrice) / call.entryPrice;
  return Math.max(0.01, gross + call.feesUsd);
}
""",
    """function plannedRisk(call: PaperCall): number {
  const fixed = Number(call.features.estimatedRiskUsd);
  if (Number.isFinite(fixed) && fixed > 0) return fixed;
  const gross = call.notionalUsd * Math.abs(call.entryPrice - call.stopPrice) / call.entryPrice;
  return Math.max(0.01, gross + call.feesUsd);
}
""",
)

replace_exact(
    'src/btc/platform/execution.ts',
    """function exitCosts(notional: number, context: MarketContext, emergency = false): number {
  const spreadBps = Math.max(0, context.feed.spreadBps ?? 4);
  const fragility = clamp(context.orderFlow.bookFragility, 0, 1);
  const slippageBps = (emergency ? 2.5 : 0.8) + spreadBps * 0.45 + fragility * (emergency ? 8 : 4);
  return notional * (DEFAULT_COST_MODEL.takerFeeRate + slippageBps / 10_000);
}
""",
    """function exitCosts(notional: number, context: MarketContext, emergency = false): number {
  const spreadBps = Math.max(0, context.feed.spreadBps ?? 4);
  const fragility = clamp(context.orderFlow.bookFragility, 0, 1);
  const slippageBps = (emergency ? 2.5 : 0.8) + spreadBps * 0.45 + fragility * (emergency ? 8 : 4);
  return notional * (DEFAULT_COST_MODEL.takerFeeRate + slippageBps / 10_000);
}

function updatePnlAccountingFeatures(call: PaperCall, projectedExitCostsUsd: number): void {
  const grossPnlUsd = call.netPnlUsd + call.feesUsd + projectedExitCostsUsd - call.fundingUsd;
  call.features.grossPnlUsd = grossPnlUsd;
  call.features.projectedExitCostsUsd = projectedExitCostsUsd;
  call.features.totalModeledCostsUsd = call.feesUsd + projectedExitCostsUsd;
}

function markRemainingPosition(call: PaperCall, context: MarketContext, exit: number): void {
  const remainingNotional = call.notionalUsd * call.remainingFraction;
  const grossUnrealized = remainingNotional * directionalMove(call.direction, call.entryPrice, exit);
  const projectedExitCostsUsd = exitCosts(remainingNotional, context);
  call.unrealizedPnlUsd = grossUnrealized - projectedExitCostsUsd + call.fundingUsd;
  call.netPnlUsd = call.realizedPnlUsd + call.unrealizedPnlUsd;
  call.roiPct = call.netPnlUsd / call.marginUsd * 100;
  call.currentR = currentR(call);
  call.maxFavorableR = Math.max(call.maxFavorableR, call.currentR);
  call.maxAdverseR = Math.min(call.maxAdverseR, call.currentR);
  updatePnlAccountingFeatures(call, projectedExitCostsUsd);
}
""",
)

replace_exact(
    'src/btc/platform/execution.ts',
    """  const initialCosts = plan.costs.entryFeeUsd + plan.costs.entrySlippageUsd + plan.costs.spreadUsd;
""",
    """  // The executable ask/bid fill already contains the market spread. Charging
  // plan.costs.spreadUsd again would double-count it.
  const initialCosts = plan.costs.entryFeeUsd + plan.costs.entrySlippageUsd;
""",
)

replace_exact(
    'src/btc/platform/execution.ts',
    """    roiPct: -initialCosts,
""",
    """    roiPct: -initialCosts / plan.marginUsd * 100,
""",
)

replace_exact(
    'src/btc/platform/execution.ts',
    """      strategyLeverageCap: candidate.strategyLeverageCap,
""",
    """      strategyLeverageCap: candidate.strategyLeverageCap,
      pnlAccountingVersion: 2,
      grossPnlUsd: 0,
      projectedExitCostsUsd: 0,
      totalModeledCostsUsd: initialCosts,
      estimatedSpreadUsdIncludedInExecutablePrices: plan.costs.spreadUsd,
""",
)

replace_exact(
    'src/btc/platform/execution.ts',
    """  call.realizedPnlUsd += call.fundingUsd;
  call.netPnlUsd = call.realizedPnlUsd;
  call.roiPct = call.netPnlUsd / call.marginUsd * 100;
  call.currentR = currentR(call);
""",
    """  call.realizedPnlUsd += call.fundingUsd;
  call.netPnlUsd = call.realizedPnlUsd;
  call.roiPct = call.netPnlUsd / call.marginUsd * 100;
  call.currentR = currentR(call);
  updatePnlAccountingFeatures(call, 0);
""",
)

replace_exact(
    'src/btc/platform/execution.ts',
    """  const remainingNotional = call.notionalUsd * call.remainingFraction;
  const grossUnrealized = remainingNotional * directionalMove(call.direction, call.entryPrice, exit);
  const projectedExitCosts = exitCosts(remainingNotional, context);
  call.unrealizedPnlUsd = grossUnrealized - projectedExitCosts + call.fundingUsd;
  call.netPnlUsd = call.realizedPnlUsd + call.unrealizedPnlUsd;
  call.roiPct = call.netPnlUsd / call.marginUsd * 100;
  call.currentR = currentR(call);
  call.maxFavorableR = Math.max(call.maxFavorableR, call.currentR);
  call.maxAdverseR = Math.min(call.maxAdverseR, call.currentR);
""",
    """  markRemainingPosition(call, context, exit);
""",
)

replace_exact(
    'src/btc/platform/execution.ts',
    """    const delta = closeFraction(call, context, exit, 0.75);
    call.runnerActivated = true;
    call.status = 'partial';
""",
    """    const delta = closeFraction(call, context, exit, 0.75);
    // Re-mark only the remaining 25%. The previous implementation retained the
    // full-position unrealized P&L after closing 75%, temporarily double-counting it.
    markRemainingPosition(call, context, exit);
    call.runnerActivated = true;
    call.status = 'partial';
""",
)

replace_exact(
    'src/btc/platform/execution.ts',
    """    call.netPnlUsd = call.realizedPnlUsd + call.unrealizedPnlUsd;
    call.roiPct = call.netPnlUsd / call.marginUsd * 100;
    events.push({
""",
    """    events.push({
""",
)

# --- Full-history and book-separated aggregation ----------------------------
insert_before_day_stats = """
export interface BtcPnlLedgerSummary {
  actionableResolvedCalls: number;
  researchResolvedCalls: number;
  actionableWins: number;
  actionableLosses: number;
  researchWins: number;
  researchLosses: number;
  actionableRealizedPnlUsd: number;
  researchRealizedPnlUsd: number;
  actionableResolvedMarginUsd: number;
  researchResolvedMarginUsd: number;
}

const EMPTY_PNL_LEDGER_SUMMARY: BtcPnlLedgerSummary = {
  actionableResolvedCalls: 0,
  researchResolvedCalls: 0,
  actionableWins: 0,
  actionableLosses: 0,
  researchWins: 0,
  researchLosses: 0,
  actionableRealizedPnlUsd: 0,
  researchRealizedPnlUsd: 0,
  actionableResolvedMarginUsd: 0,
  researchResolvedMarginUsd: 0,
};

export async function pnlLedgerSummary(): Promise<BtcPnlLedgerSummary> {
  if (!pool) return { ...EMPTY_PNL_LEDGER_SUMMARY };
  const result = await pool.query(`SELECT
    COUNT(*) FILTER (WHERE book='actionable' AND status IN ('won','lost','closed','liquidated'))::int actionable_resolved_calls,
    COUNT(*) FILTER (WHERE book='research' AND status IN ('won','lost','closed','liquidated'))::int research_resolved_calls,
    COUNT(*) FILTER (WHERE book='actionable' AND status='won')::int actionable_wins,
    COUNT(*) FILTER (WHERE book='actionable' AND status IN ('lost','liquidated'))::int actionable_losses,
    COUNT(*) FILTER (WHERE book='research' AND status='won')::int research_wins,
    COUNT(*) FILTER (WHERE book='research' AND status IN ('lost','liquidated'))::int research_losses,
    COALESCE(SUM(net_pnl_usd) FILTER (
      WHERE book='actionable' AND status IN ('won','lost','closed','liquidated')
    ),0) actionable_realized_pnl,
    COALESCE(SUM(net_pnl_usd) FILTER (
      WHERE book='research' AND status IN ('won','lost','closed','liquidated')
    ),0) research_realized_pnl,
    COALESCE(SUM(margin_usd) FILTER (
      WHERE book='actionable' AND status IN ('won','lost','closed','liquidated')
    ),0) actionable_resolved_margin,
    COALESCE(SUM(margin_usd) FILTER (
      WHERE book='research' AND status IN ('won','lost','closed','liquidated')
    ),0) research_resolved_margin
    FROM btc_paper_calls`);
  const row = result.rows[0] || {};
  return {
    actionableResolvedCalls: number(row.actionable_resolved_calls),
    researchResolvedCalls: number(row.research_resolved_calls),
    actionableWins: number(row.actionable_wins),
    actionableLosses: number(row.actionable_losses),
    researchWins: number(row.research_wins),
    researchLosses: number(row.research_losses),
    actionableRealizedPnlUsd: number(row.actionable_realized_pnl),
    researchRealizedPnlUsd: number(row.research_realized_pnl),
    actionableResolvedMarginUsd: number(row.actionable_resolved_margin),
    researchResolvedMarginUsd: number(row.research_resolved_margin),
  };
}

"""
ledger_text = Path('src/btc/platform/ledger.ts').read_text()
marker = "export async function actionableDayStats(): Promise<{ callsToday: number; realizedPnlToday: number }> {"
if marker not in ledger_text:
    raise SystemExit('missing actionableDayStats marker')
Path('src/btc/platform/ledger.ts').write_text(ledger_text.replace(marker, insert_before_day_stats + marker, 1))

replace_exact(
    'src/btc/platform/ledger.ts',
    """  const result = await pool.query(`SELECT COUNT(*)::int calls_today,COALESCE(SUM(net_pnl_usd),0) realized_pnl
    FROM btc_paper_calls WHERE book='actionable'
      AND opened_at >= date_trunc('day',now() AT TIME ZONE 'America/Chicago') AT TIME ZONE 'America/Chicago'`);
""",
    """  const result = await pool.query(`SELECT
    COUNT(*) FILTER (
      WHERE opened_at >= date_trunc('day',now() AT TIME ZONE 'America/Chicago') AT TIME ZONE 'America/Chicago'
    )::int calls_today,
    COALESCE(SUM(net_pnl_usd) FILTER (
      WHERE status IN ('won','lost','closed','liquidated')
        AND closed_at >= date_trunc('day',now() AT TIME ZONE 'America/Chicago') AT TIME ZONE 'America/Chicago'
    ),0) realized_pnl
    FROM btc_paper_calls WHERE book='actionable'`);
""",
)

# --- Engine status ----------------------------------------------------------
replace_exact(
    'src/btc/platform/engine.ts',
    """  persistRiskDecision,
  registerStrategies,
  strategyPerformance,
""",
    """  persistRiskDecision,
  pnlLedgerSummary,
  registerStrategies,
  strategyPerformance,
""",
)

replace_exact(
    'src/btc/platform/engine.ts',
    """  private performance: StrategyPerformance[] = [];
  private initialized = false;
""",
    """  private performance: StrategyPerformance[] = [];
  private pnlHistory: Awaited<ReturnType<typeof pnlLedgerSummary>> = {
    actionableResolvedCalls: 0, researchResolvedCalls: 0,
    actionableWins: 0, actionableLosses: 0, researchWins: 0, researchLosses: 0,
    actionableRealizedPnlUsd: 0, researchRealizedPnlUsd: 0,
    actionableResolvedMarginUsd: 0, researchResolvedMarginUsd: 0,
  };
  private initialized = false;
""",
)

replace_exact(
    'src/btc/platform/engine.ts',
    """    this.performance = await strategyPerformance(BTC_STRATEGIES);
    const day = await actionableDayStats();
""",
    """    this.performance = await strategyPerformance(BTC_STRATEGIES);
    this.pnlHistory = await pnlLedgerSummary();
    const day = await actionableDayStats();
""",
)

replace_exact(
    'src/btc/platform/engine.ts',
    """      if (event.call.book === 'actionable') {
        this.realizedPnlToday += event.call.netPnlUsd;
      }
""",
    """      if (event.call.book === 'actionable') {
        this.realizedPnlToday += event.call.netPnlUsd;
        this.pnlHistory.actionableResolvedCalls++;
        this.pnlHistory.actionableRealizedPnlUsd += event.call.netPnlUsd;
        this.pnlHistory.actionableResolvedMarginUsd += event.call.marginUsd;
        if (event.call.status === 'won') this.pnlHistory.actionableWins++;
        if (event.call.status === 'lost' || event.call.status === 'liquidated') this.pnlHistory.actionableLosses++;
      } else {
        this.pnlHistory.researchResolvedCalls++;
        this.pnlHistory.researchRealizedPnlUsd += event.call.netPnlUsd;
        this.pnlHistory.researchResolvedMarginUsd += event.call.marginUsd;
        if (event.call.status === 'won') this.pnlHistory.researchWins++;
        if (event.call.status === 'lost' || event.call.status === 'liquidated') this.pnlHistory.researchLosses++;
      }
""",
)

replace_exact(
    'src/btc/platform/engine.ts',
    """      this.performance = await strategyPerformance(BTC_STRATEGIES);
      const day = await actionableDayStats();
""",
    """      this.performance = await strategyPerformance(BTC_STRATEGIES);
      this.pnlHistory = await pnlLedgerSummary();
      const day = await actionableDayStats();
""",
)

replace_exact(
    'src/btc/platform/engine.ts',
    """    const actionable = active.filter(call => call.book === 'actionable');
    const completed = this.recentCalls.filter(call => terminalStates.has(call.status));
    const activePnlUsd = actionable.reduce((sum, call) => sum + call.netPnlUsd, 0);
    const realizedPnlUsd = completed.filter(call => call.book === 'actionable').reduce((sum, call) => sum + call.netPnlUsd, 0);
    const activeMarginUsd = actionable.reduce((sum, call) => sum + call.marginUsd * call.remainingFraction, 0);
    const activeNotionalUsd = actionable.reduce((sum, call) => sum + call.notionalUsd * call.remainingFraction, 0);
    const weightedLeverage = activeMarginUsd ? activeNotionalUsd / activeMarginUsd : 0;
""",
    """    const actionable = active.filter(call => call.book === 'actionable');
    const research = active.filter(call => call.book === 'research');
    const completed = this.recentCalls.filter(call => terminalStates.has(call.status));
    const actionableActivePnlUsd = actionable.reduce((sum, call) => sum + call.netPnlUsd, 0);
    const researchActivePnlUsd = research.reduce((sum, call) => sum + call.netPnlUsd, 0);
    const actionableRealizedPnlUsd = this.pnlHistory.actionableRealizedPnlUsd;
    const researchRealizedPnlUsd = this.pnlHistory.researchRealizedPnlUsd;
    const activePnlUsd = actionableActivePnlUsd + researchActivePnlUsd;
    const realizedPnlUsd = actionableRealizedPnlUsd + researchRealizedPnlUsd;
    const actionableTotalNetPnlUsd = actionableActivePnlUsd + actionableRealizedPnlUsd;
    const researchTotalNetPnlUsd = researchActivePnlUsd + researchRealizedPnlUsd;
    const totalNetPnlUsd = actionableTotalNetPnlUsd + researchTotalNetPnlUsd;
    const actionableActiveMarginUsd = actionable.reduce((sum, call) => sum + call.marginUsd * call.remainingFraction, 0);
    const researchActiveMarginUsd = research.reduce((sum, call) => sum + call.marginUsd * call.remainingFraction, 0);
    const activeMarginUsd = actionableActiveMarginUsd + researchActiveMarginUsd;
    const activeNotionalUsd = actionable.reduce((sum, call) => sum + call.notionalUsd * call.remainingFraction, 0);
    const weightedLeverage = actionableActiveMarginUsd ? activeNotionalUsd / actionableActiveMarginUsd : 0;
    const totalCapitalDeployedUsd = this.pnlHistory.actionableResolvedMarginUsd
      + this.pnlHistory.researchResolvedMarginUsd + activeMarginUsd;
    const normalizedReturnPct = totalCapitalDeployedUsd ? totalNetPnlUsd / totalCapitalDeployedUsd * 100 : 0;
""",
)

replace_exact(
    'src/btc/platform/engine.ts',
    """      portfolio: {
        activePnlUsd,
        realizedPnlUsd,
        totalNetPnlUsd: activePnlUsd + realizedPnlUsd,
        hypotheticalEquityUsd: 100 + activePnlUsd + realizedPnlUsd,
        activeMarginUsd,
        activeNotionalUsd,
        weightedLeverage,
        activeCalls: actionable.length,
        callsToday: this.callsToday,
      },
""",
    """      portfolio: {
        activePnlUsd,
        realizedPnlUsd,
        totalNetPnlUsd,
        hypotheticalEquityUsd: totalCapitalDeployedUsd + totalNetPnlUsd,
        markedValueUsd: totalCapitalDeployedUsd + totalNetPnlUsd,
        totalCapitalDeployedUsd,
        normalizedReturnPct,
        actionableActivePnlUsd,
        actionableRealizedPnlUsd,
        actionableTotalNetPnlUsd,
        researchActivePnlUsd,
        researchRealizedPnlUsd,
        researchTotalNetPnlUsd,
        actionableWins: this.pnlHistory.actionableWins,
        actionableLosses: this.pnlHistory.actionableLosses,
        researchWins: this.pnlHistory.researchWins,
        researchLosses: this.pnlHistory.researchLosses,
        actionableResolvedCalls: this.pnlHistory.actionableResolvedCalls,
        researchResolvedCalls: this.pnlHistory.researchResolvedCalls,
        activeMarginUsd,
        actionableActiveMarginUsd,
        researchActiveMarginUsd,
        activeNotionalUsd,
        weightedLeverage,
        activeCalls: actionable.length,
        researchActiveCalls: research.length,
        callsToday: this.callsToday,
      },
""",
)

# --- API type ---------------------------------------------------------------
replace_exact(
    'src/btc/platform/types.ts',
    """  portfolio: {
    activePnlUsd: number;
    realizedPnlUsd: number;
    totalNetPnlUsd: number;
    hypotheticalEquityUsd: number;
    activeMarginUsd: number;
    activeNotionalUsd: number;
    weightedLeverage: number;
    activeCalls: number;
    callsToday: number;
  };
""",
    """  portfolio: {
    activePnlUsd: number;
    realizedPnlUsd: number;
    totalNetPnlUsd: number;
    hypotheticalEquityUsd: number;
    markedValueUsd: number;
    totalCapitalDeployedUsd: number;
    normalizedReturnPct: number;
    actionableActivePnlUsd: number;
    actionableRealizedPnlUsd: number;
    actionableTotalNetPnlUsd: number;
    researchActivePnlUsd: number;
    researchRealizedPnlUsd: number;
    researchTotalNetPnlUsd: number;
    actionableWins: number;
    actionableLosses: number;
    researchWins: number;
    researchLosses: number;
    actionableResolvedCalls: number;
    researchResolvedCalls: number;
    activeMarginUsd: number;
    actionableActiveMarginUsd: number;
    researchActiveMarginUsd: number;
    activeNotionalUsd: number;
    weightedLeverage: number;
    activeCalls: number;
    researchActiveCalls: number;
    callsToday: number;
  };
""",
)

# --- Dashboard: auditable gross/cost/net breakdown and separated books ------
replace_exact(
    'public/btc-dashboard.js',
    """    const supporting = Array.isArray(call.supportingStrategies) && call.supportingStrategies.length > 1
      ? `<p class="btcSupport">Supported by ${call.supportingStrategies.map(escapeHtml).join(' · ')}</p>` : '';
""",
    """    const supporting = Array.isArray(call.supportingStrategies) && call.supportingStrategies.length > 1
      ? `<p class="btcSupport">Supported by ${call.supportingStrategies.map(escapeHtml).join(' · ')}</p>` : '';
    const projectedExitCosts = Number(call.features?.projectedExitCostsUsd || 0);
    const grossPnl = Number.isFinite(Number(call.features?.grossPnlUsd))
      ? Number(call.features.grossPnlUsd)
      : Number(call.netPnlUsd || 0) + Number(call.feesUsd || 0) + projectedExitCosts - Number(call.fundingUsd || 0);
""",
)

replace_exact(
    'public/btc-dashboard.js',
    """        <div class="metric"><small>Net P&amp;L</small><b class="${pnlClass}">${money(call.netPnlUsd)}</b></div>
        <div class="metric"><small>ROI / R</small><b class="${pnlClass}">${percent(call.roiPct)} · ${number(call.resultR ?? call.currentR)}R</b></div>
        <div class="metric"><small>Fees / funding</small><b>${money(call.feesUsd)} / ${money(call.fundingUsd)}</b></div>
""",
    """        <div class="metric"><small>Gross P&amp;L</small><b class="${Number(grossPnl) >= 0 ? 'btcPositive' : 'btcNegative'}">${money(grossPnl)}</b></div>
        <div class="metric"><small>Charged costs</small><b>${money(call.feesUsd)}</b></div>
        <div class="metric"><small>Projected exit costs</small><b>${money(projectedExitCosts)}</b></div>
        <div class="metric"><small>Funding</small><b>${money(call.fundingUsd)}</b></div>
        <div class="metric"><small>Net P&amp;L</small><b class="${pnlClass}">${money(call.netPnlUsd)}</b></div>
        <div class="metric"><small>ROI / R</small><b class="${pnlClass}">${percent(call.roiPct)} · ${number(call.resultR ?? call.currentR)}R</b></div>
""",
)

replace_exact(
    'public/btc-dashboard.js',
    """    if (byId('nBtcPnl')) byId('nBtcPnl').textContent = money(portfolio.activePnlUsd || 0);
    if (byId('nBtcRecord')) byId('nBtcRecord').textContent = `${winners.length}–${losers.length}`;
""",
    """    if (byId('nBtcPnl')) byId('nBtcPnl').textContent = money(portfolio.totalNetPnlUsd || 0);
    const allWins = Number(portfolio.actionableWins || 0) + Number(portfolio.researchWins || 0);
    const allLosses = Number(portfolio.actionableLosses || 0) + Number(portfolio.researchLosses || 0);
    if (byId('nBtcRecord')) byId('nBtcRecord').textContent = `${allWins}–${allLosses}`;
""",
)

replace_exact(
    'public/btc-dashboard.js',
    """    if (byId('btcActivePnl')) byId('btcActivePnl').textContent = money(portfolio.activePnlUsd || 0);
    if (byId('btcRealizedPnl')) byId('btcRealizedPnl').textContent = money(portfolio.realizedPnlUsd || 0);
""",
    """    if (byId('btcActivePnl')) byId('btcActivePnl').textContent = money(portfolio.activePnlUsd || 0);
    if (byId('btcRealizedPnl')) byId('btcRealizedPnl').textContent = money(portfolio.realizedPnlUsd || 0);
    if (byId('btcActionablePnl')) byId('btcActionablePnl').textContent = money(portfolio.actionableTotalNetPnlUsd || 0);
    if (byId('btcResearchPnl')) byId('btcResearchPnl').textContent = money(portfolio.researchTotalNetPnlUsd || 0);
    if (byId('btcTotalPnl')) byId('btcTotalPnl').textContent = money(portfolio.totalNetPnlUsd || 0);
    if (byId('btcNormalizedReturn')) byId('btcNormalizedReturn').textContent = percent(portfolio.normalizedReturnPct || 0);
""",
)

replace_exact(
    'public/btc-dashboard.js',
    """    const decided = winners.length + losers.length;
    if (byId('btcResultStats')) byId('btcResultStats').innerHTML = [
      stat('Decided calls', String(decided)),
      stat('Win rate', decided ? `${number(winners.length / decided * 100, 1)}%` : '—'),
      stat('Actionable realized', money(portfolio.realizedPnlUsd || 0)),
      stat('Total net P&L', money(portfolio.totalNetPnlUsd || 0)),
      stat('Calls today', String(portfolio.callsToday || 0)),
      stat('Hypothetical equity', money(portfolio.hypotheticalEquityUsd || 100)),
    ].join('');
""",
    """    const decided = allWins + allLosses;
    if (byId('btcResultStats')) byId('btcResultStats').innerHTML = [
      stat('Resolved calls', String(Number(portfolio.actionableResolvedCalls || 0) + Number(portfolio.researchResolvedCalls || 0))),
      stat('Win rate', decided ? `${number(allWins / decided * 100, 1)}%` : '—'),
      stat('Actionable net', money(portfolio.actionableTotalNetPnlUsd || 0)),
      stat('Research net', money(portfolio.researchTotalNetPnlUsd || 0)),
      stat('All BTC net', money(portfolio.totalNetPnlUsd || 0)),
      stat('Return on deployed margin', percent(portfolio.normalizedReturnPct || 0)),
      stat('Capital deployed', money(portfolio.totalCapitalDeployedUsd || 0)),
      stat('Calls today', String(portfolio.callsToday || 0)),
    ].join('');
""",
)

# --- Dashboard labels -------------------------------------------------------
replace_exact(
    'public/index.html',
    """      <button class="focusTile" data-go="btcCalls"><span class="tag">ACTIVE NET P&amp;L</span><strong id="nBtcPnl">$0.00</strong><h2>Live Portfolio</h2><p>Executable-side unrealized P&amp;L plus realized partial exits, fees, estimated funding, and liquidation-aware risk.</p><b>Track live P&amp;L →</b></button>
""",
    """      <button class="focusTile" data-go="btcCalls"><span class="tag">ALL BTC NET P&amp;L</span><strong id="nBtcPnl">$0.00</strong><h2>Live Portfolio</h2><p>Actionable and research books combined, with gross movement, charged costs, projected closing costs, funding, and net P&amp;L kept auditable.</p><b>Track live P&amp;L →</b></button>
""",
)

replace_exact(
    'public/index.html',
    """      <div class="stat"><small>Active net P&amp;L</small><b id="btcActivePnl">$0.00</b></div>
      <div class="stat"><small>Realized P&amp;L</small><b id="btcRealizedPnl">$0.00</b></div>
      <div class="stat"><small>Active notional</small><b id="btcNotional">$0</b></div>
      <div class="stat"><small>Weighted leverage</small><b id="btcLeverage">0x</b></div>
      <div class="stat"><small>Engine</small><b id="btcEngine">Connecting</b></div>
      <div class="stat"><small>Feed</small><b id="btcFeed">Checking</b></div>
      <div class="stat"><small>Regime</small><b id="btcRegime">—</b></div>
""",
    """      <div class="stat"><small>All active net</small><b id="btcActivePnl">$0.00</b></div>
      <div class="stat"><small>All realized net</small><b id="btcRealizedPnl">$0.00</b></div>
      <div class="stat"><small>Actionable net</small><b id="btcActionablePnl">$0.00</b></div>
      <div class="stat"><small>Research net</small><b id="btcResearchPnl">$0.00</b></div>
      <div class="stat"><small>All BTC net</small><b id="btcTotalPnl">$0.00</b></div>
      <div class="stat"><small>Return on deployed margin</small><b id="btcNormalizedReturn">0.00%</b></div>
      <div class="stat"><small>Actionable notional</small><b id="btcNotional">$0</b></div>
      <div class="stat"><small>Actionable leverage</small><b id="btcLeverage">0x</b></div>
      <div class="stat"><small>Engine</small><b id="btcEngine">Connecting</b></div>
      <div class="stat"><small>Feed</small><b id="btcFeed">Checking</b></div>
      <div class="stat"><small>Regime</small><b id="btcRegime">—</b></div>
""",
)

replace_exact(
    'public/index.html',
    """    <div id="btcCallList" class="callGrid"><div class="btcEmpty"><div><strong>Connecting to BTC.</strong><p>The platform only publishes an actionable alert after a strategy, execution-quality, leverage, liquidation, net +20%, 3R, portfolio, and entry-zone check all pass.</p></div></div></div>
""",
    """    <div id="btcCallList" class="callGrid"><div class="btcEmpty"><div><strong>Connecting to BTC.</strong><p>The platform only publishes an actionable alert after its strategy evidence, execution quality, leverage, liquidation, tiered net-return, portfolio, and entry-zone checks pass.</p></div></div></div>
""",
)

# --- Tests ------------------------------------------------------------------
Path('src/btc/platform/pnl.test.ts').write_text(r"""import assert from 'node:assert/strict';
import test from 'node:test';
import { createPaperCall, markPaperCall } from './execution';
import { MarketContext, RiskPlan, StrategyCandidate } from './types';

const baseContext: MarketContext = {
  timestamp: 1_000_000,
  prices: {
    last: 100,
    bid: 99.99,
    ask: 100.01,
    mark: 100,
    index: 100,
    coinbaseSpot: 100,
    krakenSpot: 100,
    consolidatedFair: 100,
  },
  candles: { oneMinute: [], fiveMinute: [], fifteenMinute: [], oneHour: [], fourHour: [] },
  derivatives: {
    fundingRate: 0,
    predictedFundingRate: 0,
    nextFundingAt: null,
    openInterest: 1,
    openInterestValue: 1,
    openInterestChangePct: 0,
    longLiquidationUsd5m: 0,
    shortLiquidationUsd5m: 0,
    basisBps: 0,
  },
  orderFlow: {
    aggressiveBuyUsd1m: 1,
    aggressiveSellUsd1m: 1,
    aggressiveBuyUsd5m: 1,
    aggressiveSellUsd5m: 1,
    topBookImbalance: 0,
    depthImbalance5Bps: 0,
    bookFragility: 0,
    absorptionScore: 0,
    bids: [{ price: 99.99, size: 10 }],
    asks: [{ price: 100.01, size: 10 }],
  },
  regime: {
    direction: 'range', volatility: 'normal', liquidity: 'deep', positioning: 'neutral',
    event: 'normal', directionalScore: 0, volatilityPercentile: 50,
  },
  feed: {
    healthy: true,
    derivativesHealthy: true,
    referenceVenue: 'TEST',
    referenceAgeMs: 0,
    coinbaseAgeMs: 0,
    krakenAgeMs: 0,
    spreadBps: 2,
    markIndexBps: 0,
    crossVenueBps: 0,
    recentSequenceGap: false,
    blockers: [],
  },
};

const candidate: StrategyCandidate = {
  id: 'pnl-test',
  strategyId: 'pnl-test',
  strategyVersion: '1.0.0',
  strategyName: 'PnL Test',
  mode: 'actionable',
  direction: 'long',
  setupType: 'test',
  createdAt: baseContext.timestamp,
  entryMethod: 'market',
  preferredEntry: 100,
  entryZoneLow: 99,
  entryZoneHigh: 101,
  doNotChasePrice: 102,
  expiresAt: baseContext.timestamp + 60_000,
  structuralStop: 99.5,
  initialTarget: 100.2,
  extendedTarget: 110,
  maximumRealisticTarget: 110,
  minimumRR: 2,
  strategyLeverageCap: 10,
  expectedHoldingMinutes: 60,
  exitModel: 'partial_runner',
  scores: { signal: 90, regime: 90, execution: 90, data: 100 },
  invalidationReasons: [],
  rationale: ['test'],
  features: {},
};

const plan: RiskPlan = {
  approved: true,
  rejectionReasons: [],
  marginUsd: 100,
  leverage: 10,
  notionalUsd: 1000,
  entryPrice: 100,
  stopPrice: 99.5,
  targetPrice: 100.2,
  extendedTargetPrice: 110,
  liquidationPrice: 90,
  liquidationBufferPct: 9.5,
  estimatedRiskUsd: 6,
  estimatedRewardUsd: 10,
  estimatedNetRR: 10 / 6,
  estimatedTargetRoiPct: 10,
  actionableTier: 'standard',
  costs: {
    entryFeeUsd: 0.55,
    exitFeeUsd: 0.55,
    entrySlippageUsd: 0.05,
    exitSlippageUsd: 0.06,
    spreadUsd: 0.2,
    expectedFundingUsd: 0,
    totalEstimatedUsd: 1.41,
  },
};

const closeCost = (notional: number) => notional * (0.00055 + (0.8 + 2 * 0.45) / 10_000);
const closeContext = (bid: number): MarketContext => ({
  ...baseContext,
  timestamp: baseContext.timestamp + 30_000,
  prices: { ...baseContext.prices, bid, ask: bid + 0.02, last: bid + 0.01, mark: bid + 0.01 },
});

const near = (actual: number, expected: number, message: string) => {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: expected ${expected}, got ${actual}`);
};

test('BTC open PnL equals executable gross move minus charged and projected costs without charging spread twice', () => {
  const { call } = createPaperCall(candidate, plan, baseContext, 'actionable');
  near(call.realizedPnlUsd, -0.60, 'entry charged costs');
  near(call.feesUsd, 0.60, 'stored charged costs');
  assert.equal(call.features.pnlAccountingVersion, 2);

  const context = closeContext(100.11);
  markPaperCall(call, context);
  const gross = 1000 * (100.11 - 100.01) / 100.01;
  const projected = closeCost(1000);
  near(Number(call.features.grossPnlUsd), gross, 'gross PnL');
  near(Number(call.features.projectedExitCostsUsd), projected, 'projected exit costs');
  near(call.netPnlUsd, gross - 0.60 - projected, 'net PnL');
  near(call.currentR, call.netPnlUsd / 6, 'R uses fixed planned risk');
});

test('BTC partial exit re-marks only the remaining fraction and does not double-count closed PnL', () => {
  const { call } = createPaperCall(candidate, plan, baseContext, 'actionable');
  const context = closeContext(100.50);
  markPaperCall(call, context);

  const gross = 1000 * (100.50 - 100.01) / 100.01;
  const chargedEntry = 0.60;
  const chargedPartialExit = closeCost(750);
  const projectedRemainderExit = closeCost(250);
  const expectedNet = gross - chargedEntry - chargedPartialExit - projectedRemainderExit;
  const expectedUnrealized = gross * 0.25 - projectedRemainderExit;

  near(call.remainingFraction, 0.25, 'remaining fraction');
  near(call.unrealizedPnlUsd, expectedUnrealized, 'remaining unrealized PnL');
  near(call.netPnlUsd, expectedNet, 'partial net PnL');
  near(Number(call.features.grossPnlUsd), gross, 'partial gross PnL');
  near(Number(call.features.projectedExitCostsUsd), projectedRemainderExit, 'remaining projected exit costs');
});
""")

# Extend the existing real-Postgres contract with all-time book separation.
replace_exact(
    'src/btc/platform/platform.integration.test.ts',
    """import { strategyPerformance } from './ledger';
""",
    """import { pnlLedgerSummary, strategyPerformance } from './ledger';
""",
)

replace_exact(
    'src/btc/platform/platform.integration.test.ts',
    """  assert.equal(performance.profitFactor, 3, 'profit factor must use resolved research calls only');
});
""",
    """  assert.equal(performance.profitFactor, 3, 'profit factor must use resolved research calls only');

  const pnl = await pnlLedgerSummary();
  assert.equal(pnl.actionableResolvedCalls, 1);
  assert.equal(pnl.actionableRealizedPnlUsd, 1000);
  assert.equal(pnl.researchResolvedCalls, 2);
  assert.equal(pnl.researchRealizedPnlUsd, 8);
  assert.equal(pnl.actionableResolvedMarginUsd, 100);
  assert.equal(pnl.researchResolvedMarginUsd, 200);
});
""",
)

print('BTC PnL accounting fix installed')
