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
  registerStrategies,
  strategyPerformance,
  updateCall,
} from './ledger';
import { assessPortfolioAdmission, DEFAULT_PORTFOLIO_LIMITS, solveRiskPlan } from './risk';
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

  private strategyHasActiveResearch(strategyId: string): boolean {
    return this.activeCalls.some(call => call.book === 'research' && call.strategyId === strategyId && activeStates.has(call.status));
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
    };
    const cooldownMinutes = cooldownByStrategy[candidate.strategyId] ?? 30;
    return candidate.createdAt - recent.openedAt < cooldownMinutes * 60_000;
  }

  private async armResearch(candidate: StrategyCandidate, plan: RiskPlan): Promise<void> {
    if (!plan.approved) return;
    if (this.strategyHasActiveResearch(candidate.strategyId)) {
      await persistRiskDecision(candidate, 'research', plan, ['research strategy already has an active call']);
      return;
    }
    if (this.strategyCooldownActive(candidate)) {
      await persistRiskDecision(candidate, 'research', plan, ['strategy cooldown is active']);
      return;
    }
    await persistRiskDecision(candidate, 'research', plan);
    this.armed.set(`research:${candidate.id}`, {
      candidate, plan, book: 'research', supportingStrategies: [candidate.strategyId], armedAt: candidate.createdAt,
    });
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
    await persistRiskDecision(candidate, 'actionable', plan, assessment.reasons);
    if (!assessment.approved || this.strategyCooldownActive(candidate)) return;
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
    const fresh: Array<{ candidate: StrategyCandidate; plan: RiskPlan }> = [];
    for (const candidate of candidates) {
      const inserted = await persistCandidate(candidate);
      if (!inserted) continue;
      const plan = solveRiskPlan(context, candidate);
      fresh.push({ candidate, plan });
    }

    const actionable = this.selectActionable(fresh);
    const selectedIds = new Set(actionable.map(item => item.candidate.id));
    for (const item of fresh.filter(item => item.candidate.mode === 'actionable' && !selectedIds.has(item.candidate.id))) {
      await persistRiskDecision(item.candidate, 'actionable', item.plan, ['not selected by duplicate/conflict coordinator']);
    }
    for (const item of actionable) await this.armActionable(item.candidate, item.plan, item.supporting);
    for (const item of fresh) await this.armResearch(item.candidate, item.plan);
  }

  private async fillArmed(context: MarketContext): Promise<void> {
    for (const [key, armed] of [...this.armed.entries()]) {
      if (armed.candidate.expiresAt <= context.timestamp) {
        this.armed.delete(key);
        await markCandidateDecision(armed.candidate.id, 'expired', 'entry was not reached before candidate expiration');
        continue;
      }
      if (!canFill(context, armed)) continue;
      if (armed.book === 'research' && this.strategyHasActiveResearch(armed.candidate.strategyId)) {
        this.armed.delete(key);
        continue;
      }
      const { call, event } = createPaperCall(
        armed.candidate,
        armed.plan,
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
    const completed = this.recentCalls.filter(call => terminalStates.has(call.status));
    const activePnlUsd = actionable.reduce((sum, call) => sum + call.netPnlUsd, 0);
    const realizedPnlUsd = completed.filter(call => call.book === 'actionable').reduce((sum, call) => sum + call.netPnlUsd, 0);
    const activeMarginUsd = actionable.reduce((sum, call) => sum + call.marginUsd * call.remainingFraction, 0);
    const activeNotionalUsd = actionable.reduce((sum, call) => sum + call.notionalUsd * call.remainingFraction, 0);
    const weightedLeverage = activeMarginUsd ? activeNotionalUsd / activeMarginUsd : 0;
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
      portfolio: {
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
