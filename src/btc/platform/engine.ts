import { createPaperCall, ExecutionEvent, markPaperCall } from './execution';
import { publishEntryAlert, publishExecutionAlert } from './alerts';
import {
  actionableDayStats,
  appendCallEvent,
  initializeBtcPlatformSchema,
  insertCall,
  loadActiveCalls,
  loadRecentCalls,
  markCandidateDecision,
  persistCandidate,
  persistRiskDecision,
  pnlLedgerSummary,
  registerStrategies,
  strategyPerformance,
  updateCall,
} from './ledger';
import { assessPortfolioAdmission, DEFAULT_PORTFOLIO_LIMITS, solveRiskPlan } from './risk';
import { solveResearchRiskPlan } from './research-risk';
import { BTC_STRATEGIES } from './strategy-registry';
import {
  CallBook,
  MarketContext,
  PaperCall,
  PlatformStatus,
  RiskPlan,
  StrategyCandidate,
  StrategyPerformance,
} from './types';

interface ArmedCandidate {
  candidate: StrategyCandidate;
  plan: RiskPlan;
  book: CallBook;
  supportingStrategies: string[];
  armedAt: number;
}

const activeStates = new Set(['armed', 'open', 'partial']);
const terminalStates = new Set(['won', 'lost', 'closed', 'liquidated', 'missed', 'cancelled']);

function combinedConfidence(candidate: StrategyCandidate): number {
  return candidate.scores.signal * 0.4
    + candidate.scores.regime * 0.25
    + candidate.scores.execution * 0.25
    + candidate.scores.data * 0.1;
}

function executableEntry(context: MarketContext, candidate: StrategyCandidate): number {
  return candidate.direction === 'long' ? context.prices.ask : context.prices.bid;
}

function canFill(context: MarketContext, armed: ArmedCandidate): boolean {
  const price = executableEntry(context, armed.candidate);
  const candidate = armed.candidate;
  if (candidate.direction === 'long' && price > candidate.doNotChasePrice) return false;
  if (candidate.direction === 'short' && price < candidate.doNotChasePrice) return false;
  if (candidate.entryMethod === 'market') return true;
  if (candidate.entryMethod === 'stop') {
    return candidate.direction === 'long'
      ? price >= candidate.preferredEntry && price <= candidate.doNotChasePrice
      : price <= candidate.preferredEntry && price >= candidate.doNotChasePrice;
  }
  return price >= candidate.entryZoneLow && price <= candidate.entryZoneHigh;
}

function sameTrade(first: StrategyCandidate, second: StrategyCandidate): boolean {
  return first.direction === second.direction
    && Math.abs(first.preferredEntry - second.preferredEntry) / Math.max(first.preferredEntry, 1) <= 0.0025;
}

export class BtcMultiStrategyEngine {
  private activeCalls: PaperCall[] = [];
  private recentCalls: PaperCall[] = [];
  private armed = new Map<string, ArmedCandidate>();
  private latestCandidates: StrategyCandidate[] = [];
  private performance: StrategyPerformance[] = [];
  private pnlHistory: Awaited<ReturnType<typeof pnlLedgerSummary>> = {
    actionableResolvedCalls: 0, researchResolvedCalls: 0,
    actionableWins: 0, actionableLosses: 0, researchWins: 0, researchLosses: 0,
    actionableRealizedPnlUsd: 0, researchRealizedPnlUsd: 0,
    actionableResolvedMarginUsd: 0, researchResolvedMarginUsd: 0,
  };
  private initialized = false;
  private lastPerformanceAt = 0;
  private lastContext: MarketContext | null = null;
  private callsToday = 0;
  private realizedPnlToday = 0;
  private blockers: string[] = [];

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await initializeBtcPlatformSchema();
    await registerStrategies(BTC_STRATEGIES);
    this.activeCalls = await loadActiveCalls();
    this.recentCalls = await loadRecentCalls();
    this.performance = await strategyPerformance(BTC_STRATEGIES);
    this.pnlHistory = await pnlLedgerSummary();
    const day = await actionableDayStats();
    this.callsToday = day.callsToday;
    this.realizedPnlToday = day.realizedPnlToday;
    this.initialized = true;
  }

  private async handleExecutionEvent(event: ExecutionEvent): Promise<void> {
    await updateCall(event.call);
    await appendCallEvent(event);
    if (event.type !== 'pnl_snapshot') await publishExecutionAlert(event).catch(() => {});
    if (terminalStates.has(event.call.status)) {
      this.activeCalls = this.activeCalls.filter(call => call.id !== event.call.id);
      this.recentCalls = [event.call, ...this.recentCalls.filter(call => call.id !== event.call.id)].slice(0, 300);
      if (event.call.book === 'actionable') {
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
    }
  }

  private async markOpenCalls(context: MarketContext): Promise<void> {
    for (const call of [...this.activeCalls]) {
      const events = markPaperCall(call, context);
      for (const event of events) await this.handleExecutionEvent(event);
      if (!events.length) await updateCall(call);
    }
  }

  private strategyHasResearchExposure(strategyId: string): boolean {
    const active = this.activeCalls.some(call => call.book === 'research'
      && call.strategyId === strategyId && activeStates.has(call.status));
    const armed = [...this.armed.values()].some(item => item.book === 'research'
      && item.candidate.strategyId === strategyId);
    return active || armed;
  }

  private strategyCooldownActive(candidate: StrategyCandidate): boolean {
    const recent = [...this.activeCalls, ...this.recentCalls]
      .filter(call => call.strategyId === candidate.strategyId)
      .sort((a, b) => b.openedAt - a.openedAt)[0];
    if (!recent) return false;
    const cooldownByStrategy: Record<string, number> = {
      'btc-cross-venue-lag': 5,
      'btc-orderflow-absorption': 10,
      'btc-adaptive-trend-rider': 120,
      'btc-donchian-trend-breakout': 60,
      'btc-funding-crowding-reversal': 120,
      'btc-perp-premium-convergence': 45,
      'btc-price-oi-state': 45,
      'btc-liquidation-cascade-exhaustion': 30,
      'btc-cvd-divergence': 20,
      'btc-microprice-orderbook-scalper': 2,
      'btc-eth-led-catch-up': 15,
      'btc-post-jump-continuation': 45,
    };
    const cooldownMinutes = cooldownByStrategy[candidate.strategyId] ?? 30;
    return candidate.createdAt - recent.openedAt < cooldownMinutes * 60_000;
  }

  private researchCapacityReason(candidate: StrategyCandidate): string | null {
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
      return `research concurrency cap of ${maxGlobal} active or armed calls is reached`;
    }
    const maxPerDirection = Math.max(1, Math.ceil(maxGlobal / 2));
    const sameDirection = exposures.filter(item => item.direction === candidate.direction).length;
    if (sameDirection >= maxPerDirection) {
      return `research ${candidate.direction}-direction cap of ${maxPerDirection} is reached`;
    }
    return null;
  }

  private async armResearch(candidate: StrategyCandidate, plan: RiskPlan): Promise<boolean> {
    if (!plan.approved) {
      await persistRiskDecision(candidate, 'research', plan, plan.rejectionReasons);
      return false;
    }
    if (this.strategyHasResearchExposure(candidate.strategyId)) {
      await persistRiskDecision(candidate, 'research', plan, ['research strategy already has an active or armed call']);
      return false;
    }
    const capacityReason = this.researchCapacityReason(candidate);
    if (capacityReason) {
      await persistRiskDecision(candidate, 'research', plan, [capacityReason]);
      return false;
    }
    if (this.strategyCooldownActive(candidate)) {
      await persistRiskDecision(candidate, 'research', plan, ['strategy cooldown is active']);
      return false;
    }
    await persistRiskDecision(candidate, 'research', plan);
    this.armed.set(`research:${candidate.id}`, {
      candidate, plan, book: 'research', supportingStrategies: [candidate.strategyId], armedAt: candidate.createdAt,
    });
    return true;
  }

  private selectActionable(candidates: Array<{ candidate: StrategyCandidate; plan: RiskPlan }>): Array<{ candidate: StrategyCandidate; plan: RiskPlan; supporting: string[] }> {
    const approved = candidates.filter(item => item.plan.approved && item.candidate.mode === 'actionable');
    if (!approved.length) return [];
    const longScore = approved.filter(item => item.candidate.direction === 'long')
      .reduce((sum, item) => sum + combinedConfidence(item.candidate), 0);
    const shortScore = approved.filter(item => item.candidate.direction === 'short')
      .reduce((sum, item) => sum + combinedConfidence(item.candidate), 0);
    if (longScore > 0 && shortScore > 0 && Math.abs(longScore - shortScore) < 18) return [];
    const direction = longScore >= shortScore ? 'long' : 'short';
    const directional = approved
      .filter(item => item.candidate.direction === direction)
      .sort((a, b) => combinedConfidence(b.candidate) - combinedConfidence(a.candidate));
    const selected: Array<{ candidate: StrategyCandidate; plan: RiskPlan; supporting: string[] }> = [];
    const consumed = new Set<string>();
    for (const lead of directional) {
      if (consumed.has(lead.candidate.id)) continue;
      const matching = directional.filter(item => !consumed.has(item.candidate.id) && sameTrade(lead.candidate, item.candidate));
      matching.forEach(item => consumed.add(item.candidate.id));
      selected.push({
        candidate: lead.candidate,
        plan: lead.plan,
        supporting: matching.map(item => item.candidate.strategyId),
      });
    }
    return selected;
  }

  private async armActionable(
    candidate: StrategyCandidate,
    plan: RiskPlan,
    supportingStrategies: string[],
  ): Promise<void> {
    const assessment = assessPortfolioAdmission(
      candidate,
      plan,
      this.activeCalls,
      this.callsToday,
      this.realizedPnlToday,
      DEFAULT_PORTFOLIO_LIMITS,
    );
    const cooldownActive = this.strategyCooldownActive(candidate);
    await persistRiskDecision(candidate, 'actionable', plan, [
      ...assessment.reasons,
      ...(cooldownActive ? ['strategy cooldown is active'] : []),
    ]);
    if (!assessment.approved || cooldownActive) return;
    this.armed.set(`actionable:${candidate.id}`, {
      candidate, plan, book: 'actionable', supportingStrategies, armedAt: candidate.createdAt,
    });
    for (const strategyId of supportingStrategies) {
      if (strategyId !== candidate.strategyId) {
        const supporting = this.latestCandidates.find(item => item.strategyId === strategyId && sameTrade(item, candidate));
        if (supporting) await markCandidateDecision(supporting.id, 'merged', `merged into actionable call led by ${candidate.strategyId}`);
      }
    }
  }

  private async evaluateStrategies(context: MarketContext): Promise<void> {
    const candidates = BTC_STRATEGIES.flatMap(strategy => {
      try { return strategy.evaluate(context); }
      catch (error) {
        console.error(`[btc-strategy:${strategy.id}]`, (error as Error).message);
        return [];
      }
    });
    this.latestCandidates = candidates.slice(0, 30);
    const fresh: Array<{
      candidate: StrategyCandidate;
      actionablePlan: RiskPlan;
      researchPlan: RiskPlan;
    }> = [];
    const evidenceByVersion = new Map(this.performance.map(item => [
      `${item.strategyId}:${item.strategyVersion}`,
      item,
    ]));
    for (const candidate of candidates) {
      const inserted = await persistCandidate(candidate);
      if (!inserted) continue;
      fresh.push({
        candidate,
        actionablePlan: solveRiskPlan(
          context,
          candidate,
          evidenceByVersion.get(`${candidate.strategyId}:${candidate.strategyVersion}`) || null,
        ),
        researchPlan: solveResearchRiskPlan(context, candidate),
      });
    }

    const actionable = this.selectActionable(fresh.map(item => ({
      candidate: item.candidate,
      plan: item.actionablePlan,
    })));
    const selectedIds = new Set(actionable.map(item => item.candidate.id));
    for (const item of fresh.filter(item => item.candidate.mode === 'actionable' && !selectedIds.has(item.candidate.id))) {
      await persistRiskDecision(
        item.candidate,
        'actionable',
        item.actionablePlan,
        ['not selected by duplicate/conflict coordinator'],
      );
    }
    for (const item of actionable) await this.armActionable(item.candidate, item.plan, item.supporting);

    const actionableCandidateIds = new Set(actionable.map(item => item.candidate.id));
    const researchPool = fresh
      .filter(item => !actionableCandidateIds.has(item.candidate.id))
      .filter(item => item.candidate.mode === 'shadow' || !item.actionablePlan.approved)
      .sort((a, b) => combinedConfidence(b.candidate) - combinedConfidence(a.candidate));
    for (const item of researchPool) {
      if (!item.researchPlan.approved) {
        await persistRiskDecision(item.candidate, 'research', item.researchPlan, item.researchPlan.rejectionReasons);
        continue;
      }
      await this.armResearch(item.candidate, item.researchPlan);
    }
  }

  private async fillArmed(context: MarketContext): Promise<void> {
    for (const [key, armed] of [...this.armed.entries()]) {
      if (armed.candidate.expiresAt <= context.timestamp) {
        this.armed.delete(key);
        await markCandidateDecision(armed.candidate.id, 'expired', 'entry was not reached before candidate expiration');
        continue;
      }
      if (!canFill(context, armed)) continue;
      if (armed.book === 'research' && this.strategyHasResearchExposure(armed.candidate.strategyId)) {
        this.armed.delete(key);
        continue;
      }
      const fillPrice = executableEntry(context, armed.candidate);
      const repricedCandidate: StrategyCandidate = { ...armed.candidate, preferredEntry: fillPrice };
      const evidence = this.performance.find(item => item.strategyId === repricedCandidate.strategyId
        && item.strategyVersion === repricedCandidate.strategyVersion) || null;
      const repricedPlan = armed.book === 'research'
        ? solveResearchRiskPlan(context, repricedCandidate)
        : solveRiskPlan(context, repricedCandidate, evidence);
      if (!repricedPlan.approved) {
        this.armed.delete(key);
        await persistRiskDecision(repricedCandidate, armed.book, repricedPlan, [
          ...repricedPlan.rejectionReasons,
          'actual executable fill failed risk revalidation',
        ]);
        await markCandidateDecision(armed.candidate.id, 'missed', 'actual executable fill failed risk revalidation');
        continue;
      }
      const { call, event } = createPaperCall(
        repricedCandidate,
        repricedPlan,
        context,
        armed.book,
        armed.supportingStrategies,
      );
      try {
        await insertCall(call);
      } catch (error) {
        console.error('[btc-call-insert]', (error as Error).message);
        this.armed.delete(key);
        continue;
      }
      await appendCallEvent(event);
      this.activeCalls.push(call);
      this.recentCalls = [call, ...this.recentCalls.filter(existing => existing.id !== call.id)].slice(0, 300);
      this.armed.delete(key);
      if (call.book === 'actionable') {
        this.callsToday++;
        await publishEntryAlert(call, armed.candidate).catch(() => {});
      }
    }
  }

  async evaluate(context: MarketContext): Promise<void> {
    await this.initialize();
    this.lastContext = context;
    this.blockers = context.feed.blockers;
    await this.markOpenCalls(context);
    await this.evaluateStrategies(context);
    await this.fillArmed(context);
    if (context.timestamp - this.lastPerformanceAt >= 60_000) {
      this.performance = await strategyPerformance(BTC_STRATEGIES);
      this.pnlHistory = await pnlLedgerSummary();
      const day = await actionableDayStats();
      this.callsToday = day.callsToday;
      this.realizedPnlToday = day.realizedPnlToday;
      this.lastPerformanceAt = context.timestamp;
    }
  }

  getStatus(): PlatformStatus {
    const context = this.lastContext;
    const active = this.activeCalls.filter(call => activeStates.has(call.status));
    const actionable = active.filter(call => call.book === 'actionable');
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
    const winners = completed.filter(call => call.status === 'won');
    const losers = completed.filter(call => call.status === 'lost' || call.status === 'liquidated');
    const emptyFeed = {
      healthy: false, derivativesHealthy: false, referenceVenue: 'BYBIT-BTCUSDT', referenceAgeMs: null,
      coinbaseAgeMs: null, krakenAgeMs: null, spreadBps: null, markIndexBps: null,
      crossVenueBps: null, recentSequenceGap: false, blockers: ['BTC market context has not initialized'],
    };
    return {
      market: 'BTC-PERP',
      mode: 'paper',
      executionEnabled: false,
      referenceVenue: context?.feed.referenceVenue || 'BYBIT-BTCUSDT',
      engineState: !this.initialized ? 'initializing' : !context ? 'waiting_for_market_data'
        : context.feed.healthy ? 'scanning' : 'blocked',
      prices: context?.prices || null,
      feed: context?.feed || emptyFeed,
      regime: context?.regime || null,
      crossAsset: context?.crossAsset || null,
      portfolio: {
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
      activeCalls: active,
      recentCalls: this.recentCalls.slice(0, 100),
      winners: winners.slice(0, 100),
      losers: losers.slice(0, 100),
      strategies: this.performance,
      latestCandidates: this.latestCandidates,
      blockers: this.blockers,
      updatedAt: new Date(context?.timestamp || Date.now()).toISOString(),
    };
  }
}
