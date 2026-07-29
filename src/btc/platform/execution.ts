import crypto from 'crypto';
import { averageTrueRange, clamp, safeDiv } from './indicators';
import {
  BtcDirection,
  CallBook,
  MarketContext,
  PaperCall,
  RiskPlan,
  StrategyCandidate,
} from './types';
import { DEFAULT_COST_MODEL } from './risk';

export type ExecutionEventType = 'entry_filled' | 'pnl_snapshot' | 'partial_take_profit' | 'stop_updated' | 'position_closed' | 'position_liquidated';

export interface ExecutionEvent {
  type: ExecutionEventType;
  call: PaperCall;
  price: number;
  timestamp: number;
  reason: string;
  realizedPnlDeltaUsd: number;
}

function executablePrice(context: MarketContext, direction: BtcDirection, action: 'entry' | 'exit'): number {
  if (action === 'entry') return direction === 'long' ? context.prices.ask : context.prices.bid;
  return direction === 'long' ? context.prices.bid : context.prices.ask;
}

function directionalMove(direction: BtcDirection, entry: number, exit: number): number {
  return direction === 'long' ? safeDiv(exit - entry, entry) : safeDiv(entry - exit, entry);
}

function plannedRisk(call: PaperCall): number {
  const gross = call.notionalUsd * Math.abs(call.entryPrice - call.stopPrice) / call.entryPrice;
  return Math.max(0.01, gross + call.feesUsd);
}

function currentR(call: PaperCall): number {
  return safeDiv(call.netPnlUsd, plannedRisk(call));
}

function exitCosts(notional: number, context: MarketContext, emergency = false): number {
  const spreadBps = Math.max(0, context.feed.spreadBps ?? 4);
  const fragility = clamp(context.orderFlow.bookFragility, 0, 1);
  const slippageBps = (emergency ? 2.5 : 0.8) + spreadBps * 0.45 + fragility * (emergency ? 8 : 4);
  return notional * (DEFAULT_COST_MODEL.takerFeeRate + slippageBps / 10_000);
}

function estimateFunding(call: PaperCall, context: MarketContext, at: number): number {
  const elapsedIntervals = Math.floor(Math.max(0, at - call.simulatedFillAt) / (8 * 60 * 60_000));
  if (!elapsedIntervals) return 0;
  const rate = Math.abs(context.derivatives.fundingRate);
  const pays = call.direction === 'long'
    ? context.derivatives.fundingRate > 0
    : context.derivatives.fundingRate < 0;
  const amount = call.notionalUsd * call.remainingFraction * rate * elapsedIntervals;
  return pays ? -amount : amount;
}

function closeFraction(
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
}

export function createPaperCall(
  candidate: StrategyCandidate,
  plan: RiskPlan,
  context: MarketContext,
  book: CallBook,
  supportingStrategies: string[] = [candidate.strategyId],
): { call: PaperCall; event: ExecutionEvent } {
  const fill = executablePrice(context, candidate.direction, 'entry');
  const initialCosts = plan.costs.entryFeeUsd + plan.costs.entrySlippageUsd + plan.costs.spreadUsd;
  const call: PaperCall = {
    id: crypto.randomUUID(),
    book,
    strategyId: candidate.strategyId,
    strategyVersion: candidate.strategyVersion,
    strategyName: candidate.strategyName,
    supportingStrategies,
    direction: candidate.direction,
    status: 'open',
    marginUsd: plan.marginUsd,
    leverage: plan.leverage,
    notionalUsd: plan.notionalUsd,
    entryPrice: fill,
    currentPrice: fill,
    stopPrice: plan.stopPrice,
    targetPrice: plan.targetPrice,
    extendedTargetPrice: plan.extendedTargetPrice,
    liquidationPrice: plan.liquidationPrice,
    confidence: Math.round(
      candidate.scores.signal * 0.4
      + candidate.scores.regime * 0.25
      + candidate.scores.execution * 0.25
      + candidate.scores.data * 0.1,
    ),
    openedAt: context.timestamp,
    closedAt: null,
    exitPrice: null,
    exitReason: null,
    realizedPnlUsd: -initialCosts,
    unrealizedPnlUsd: 0,
    netPnlUsd: -initialCosts,
    roiPct: -initialCosts,
    currentR: -safeDiv(initialCosts, plan.estimatedRiskUsd, 0),
    resultR: null,
    maxFavorableR: 0,
    maxAdverseR: 0,
    remainingFraction: 1,
    runnerActivated: false,
    trailingStopPrice: null,
    feesUsd: initialCosts,
    fundingUsd: 0,
    entryAlertAt: context.timestamp,
    simulatedFillAt: context.timestamp,
    rationale: candidate.rationale,
    features: {
      ...candidate.features,
      setupType: candidate.setupType,
      entryMethod: candidate.entryMethod,
      exitModel: candidate.exitModel,
      expectedHoldingMinutes: candidate.expectedHoldingMinutes,
      estimatedRiskUsd: plan.estimatedRiskUsd,
      estimatedRewardUsd: plan.estimatedRewardUsd,
      estimatedNetRR: plan.estimatedNetRR,
      estimatedTargetRoiPct: plan.estimatedTargetRoiPct,
      strategyLeverageCap: candidate.strategyLeverageCap,
    },
  };
  return {
    call,
    event: {
      type: 'entry_filled', call, price: fill, timestamp: context.timestamp,
      reason: `${book} paper entry filled after risk approval`, realizedPnlDeltaUsd: -initialCosts,
    },
  };
}

function finishCall(
  call: PaperCall,
  context: MarketContext,
  price: number,
  at: number,
  reason: string,
  liquidated = false,
): ExecutionEvent {
  const delta = closeFraction(call, context, price, call.remainingFraction, liquidated || reason.includes('emergency'));
  call.currentPrice = price;
  call.unrealizedPnlUsd = 0;
  call.fundingUsd = estimateFunding(call, context, at);
  call.realizedPnlUsd += call.fundingUsd;
  call.netPnlUsd = call.realizedPnlUsd;
  call.roiPct = call.netPnlUsd / call.marginUsd * 100;
  call.currentR = currentR(call);
  call.resultR = call.currentR;
  call.maxFavorableR = Math.max(call.maxFavorableR, call.currentR);
  call.maxAdverseR = Math.min(call.maxAdverseR, call.currentR);
  call.status = liquidated ? 'liquidated' : call.netPnlUsd > 0 ? 'won' : call.netPnlUsd < 0 ? 'lost' : 'closed';
  call.closedAt = at;
  call.exitPrice = price;
  call.exitReason = reason;
  return {
    type: liquidated ? 'position_liquidated' : 'position_closed',
    call,
    price,
    timestamp: at,
    reason,
    realizedPnlDeltaUsd: delta + call.fundingUsd,
  };
}

export function markPaperCall(call: PaperCall, context: MarketContext): ExecutionEvent[] {
  if (!['open', 'partial'].includes(call.status)) return [];
  const events: ExecutionEvent[] = [];
  const at = context.timestamp;
  const exit = executablePrice(context, call.direction, 'exit');
  const mark = context.prices.mark;
  call.currentPrice = exit;
  call.fundingUsd = estimateFunding(call, context, at);

  const remainingNotional = call.notionalUsd * call.remainingFraction;
  const grossUnrealized = remainingNotional * directionalMove(call.direction, call.entryPrice, exit);
  const projectedExitCosts = exitCosts(remainingNotional, context);
  call.unrealizedPnlUsd = grossUnrealized - projectedExitCosts + call.fundingUsd;
  call.netPnlUsd = call.realizedPnlUsd + call.unrealizedPnlUsd;
  call.roiPct = call.netPnlUsd / call.marginUsd * 100;
  call.currentR = currentR(call);
  call.maxFavorableR = Math.max(call.maxFavorableR, call.currentR);
  call.maxAdverseR = Math.min(call.maxAdverseR, call.currentR);

  const liquidationHit = call.direction === 'long' ? mark <= call.liquidationPrice : mark >= call.liquidationPrice;
  if (liquidationHit) {
    events.push(finishCall(call, context, exit, at, 'mark-price liquidation threshold reached', true));
    return events;
  }

  const stopReference = call.trailingStopPrice ?? call.stopPrice;
  const stopHit = call.direction === 'long' ? mark <= stopReference : mark >= stopReference;
  if (stopHit) {
    events.push(finishCall(call, context, exit, at, call.runnerActivated ? 'runner trailing stop reached' : 'structural stop reached'));
    return events;
  }

  const targetHit = call.direction === 'long' ? exit >= call.targetPrice : exit <= call.targetPrice;
  const exitModel = String(call.features.exitModel || 'fixed');
  if (targetHit && !call.runnerActivated && exitModel === 'partial_runner') {
    const delta = closeFraction(call, context, exit, 0.75);
    call.runnerActivated = true;
    call.status = 'partial';
    const costBufferPct = safeDiv(call.feesUsd + Math.max(0, -call.fundingUsd), call.notionalUsd * Math.max(call.remainingFraction, 0.01));
    call.trailingStopPrice = call.direction === 'long'
      ? call.entryPrice * (1 + costBufferPct)
      : call.entryPrice * (1 - costBufferPct);
    call.netPnlUsd = call.realizedPnlUsd + call.unrealizedPnlUsd;
    call.roiPct = call.netPnlUsd / call.marginUsd * 100;
    events.push({
      type: 'partial_take_profit', call, price: exit, timestamp: at,
      reason: '75% closed at the initial net target; 25% runner activated', realizedPnlDeltaUsd: delta,
    });
    events.push({
      type: 'stop_updated', call, price: call.trailingStopPrice, timestamp: at,
      reason: 'runner stop moved to fee-adjusted protected entry', realizedPnlDeltaUsd: 0,
    });
  } else if (targetHit && !call.runnerActivated) {
    events.push(finishCall(call, context, exit, at, 'fixed take-profit target reached'));
    return events;
  }

  if (call.runnerActivated) {
    const atr = averageTrueRange(context.candles.oneMinute, 20);
    if (atr > 0) {
      const proposed = call.direction === 'long' ? mark - atr * 1.6 : mark + atr * 1.6;
      const current = call.trailingStopPrice ?? call.stopPrice;
      const tightened = call.direction === 'long' ? Math.max(current, proposed) : Math.min(current, proposed);
      const meaningful = Math.abs(tightened - current) / call.entryPrice >= 0.00025;
      if (meaningful) {
        call.trailingStopPrice = tightened;
        events.push({
          type: 'stop_updated', call, price: tightened, timestamp: at,
          reason: 'runner stop tightened behind one-minute ATR structure', realizedPnlDeltaUsd: 0,
        });
      }
    }
    if (call.extendedTargetPrice !== null) {
      const extendedHit = call.direction === 'long' ? exit >= call.extendedTargetPrice : exit <= call.extendedTargetPrice;
      if (extendedHit) {
        events.push(finishCall(call, context, exit, at, 'extended runner target reached'));
        return events;
      }
    }
  }

  const maxHoldingMinutes = Number(call.features.expectedHoldingMinutes || 480);
  if (at - call.openedAt >= maxHoldingMinutes * 60_000) {
    events.push(finishCall(call, context, exit, at, 'strategy maximum holding time reached'));
    return events;
  }

  if (!context.feed.healthy && (context.feed.referenceAgeMs ?? Infinity) > 30_000) {
    events.push(finishCall(call, context, exit, at, 'emergency exit after prolonged reference-feed degradation'));
    return events;
  }

  events.push({
    type: 'pnl_snapshot', call, price: exit, timestamp: at,
    reason: 'paper position marked to executable exit and mark-price risk', realizedPnlDeltaUsd: 0,
  });
  return events;
}
