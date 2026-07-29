import {
  BtcDirection,
  Candle,
  EntryMethod,
  ExitModel,
  MarketContext,
  StrategyCandidate,
  StrategyMode,
} from '../types';
import { clamp, safeDiv } from '../indicators';

export interface CandidateInput {
  strategyId: string;
  strategyVersion: string;
  strategyName: string;
  mode: StrategyMode;
  direction: BtcDirection;
  setupType: string;
  entryMethod: EntryMethod;
  preferredEntry: number;
  entryZoneLow: number;
  entryZoneHigh: number;
  doNotChasePrice: number;
  expiresAt: number;
  structuralStop: number;
  initialTarget: number;
  extendedTarget: number | null;
  maximumRealisticTarget: number;
  minimumRR?: number;
  strategyLeverageCap: number;
  expectedHoldingMinutes: number;
  exitModel: ExitModel;
  signalScore: number;
  regimeScore: number;
  executionScore: number;
  dataScore?: number;
  rationale: string[];
  features: Record<string, number | string | boolean | null>;
}

export const complete = (candles: Candle[]): Candle[] => candles.filter(candle => candle.complete);
export const currentPrice = (context: MarketContext, direction: BtcDirection): number =>
  direction === 'long' ? context.prices.ask : context.prices.bid;

export function candidate(context: MarketContext, input: CandidateInput): StrategyCandidate {
  const minuteBucket = Math.floor(context.timestamp / 60_000);
  return {
    id: `${input.strategyId}:${input.strategyVersion}:${input.direction}:${minuteBucket}`,
    strategyId: input.strategyId,
    strategyVersion: input.strategyVersion,
    strategyName: input.strategyName,
    mode: input.mode,
    direction: input.direction,
    setupType: input.setupType,
    createdAt: context.timestamp,
    entryMethod: input.entryMethod,
    preferredEntry: input.preferredEntry,
    entryZoneLow: Math.min(input.entryZoneLow, input.entryZoneHigh),
    entryZoneHigh: Math.max(input.entryZoneLow, input.entryZoneHigh),
    doNotChasePrice: input.doNotChasePrice,
    expiresAt: input.expiresAt,
    structuralStop: input.structuralStop,
    initialTarget: input.initialTarget,
    extendedTarget: input.extendedTarget,
    maximumRealisticTarget: input.maximumRealisticTarget,
    minimumRR: input.minimumRR ?? 3,
    strategyLeverageCap: input.strategyLeverageCap,
    expectedHoldingMinutes: input.expectedHoldingMinutes,
    exitModel: input.exitModel,
    scores: {
      signal: Math.round(clamp(input.signalScore, 0, 100)),
      regime: Math.round(clamp(input.regimeScore, 0, 100)),
      execution: Math.round(clamp(input.executionScore, 0, 100)),
      data: Math.round(clamp(input.dataScore ?? (context.feed.healthy ? 100 : 0), 0, 100)),
    },
    invalidationReasons: [],
    rationale: input.rationale,
    features: input.features,
  };
}

export function targetFromRisk(entry: number, stop: number, direction: BtcDirection, multiple: number): number {
  const risk = Math.abs(entry - stop);
  return direction === 'long' ? entry + risk * multiple : entry - risk * multiple;
}

export function executionScore(context: MarketContext, fragilityWeight = 28): number {
  return 92 - (context.feed.spreadBps || 0) * 4 - context.orderFlow.bookFragility * fragilityWeight;
}

export function directionalFlow(context: MarketContext, direction: BtcDirection, window: 'one' | 'five' = 'five'): number {
  const buy = window === 'one' ? context.orderFlow.aggressiveBuyUsd1m : context.orderFlow.aggressiveBuyUsd5m;
  const sell = window === 'one' ? context.orderFlow.aggressiveSellUsd1m : context.orderFlow.aggressiveSellUsd5m;
  return direction === 'long' ? safeDiv(buy, sell, 1) : safeDiv(sell, buy, 1);
}

export function candleDelta(candle: Candle): number {
  return candle.buyVolume - candle.sellVolume;
}

export function recentSwing(candles: Candle[], direction: BtcDirection, count: number): number {
  const sample = complete(candles).slice(-count);
  if (!sample.length) return 0;
  return direction === 'long'
    ? Math.min(...sample.map(candle => candle.low))
    : Math.max(...sample.map(candle => candle.high));
}
