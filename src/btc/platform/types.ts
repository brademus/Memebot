export type BtcDirection = 'long' | 'short';
export type StrategyMode = 'actionable' | 'shadow';
export type ActionableAlertTier = 'standard' | 'a_plus';
export type EntryMethod = 'market' | 'limit' | 'stop' | 'retest';
export type ExitModel = 'fixed' | 'partial_runner';
export type CallBook = 'research' | 'actionable';
export type CallStatus = 'armed' | 'open' | 'partial' | 'won' | 'lost' | 'closed' | 'liquidated' | 'missed' | 'cancelled';

export interface Candle {
  timeframeSec: number;
  startMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  tradeCount: number;
  buyVolume: number;
  sellVolume: number;
  complete: boolean;
}

export interface BookLevel {
  price: number;
  size: number;
}

export interface PriceState {
  last: number;
  bid: number;
  ask: number;
  mark: number;
  index: number;
  coinbaseSpot: number | null;
  krakenSpot: number | null;
  consolidatedFair: number;
}

export interface FeedQuality {
  healthy: boolean;
  derivativesHealthy: boolean;
  referenceVenue: string;
  referenceAgeMs: number | null;
  coinbaseAgeMs: number | null;
  krakenAgeMs: number | null;
  spreadBps: number | null;
  markIndexBps: number | null;
  crossVenueBps: number | null;
  recentSequenceGap: boolean;
  blockers: string[];
}

export interface DerivativesState {
  fundingRate: number;
  predictedFundingRate: number;
  nextFundingAt: number | null;
  openInterest: number;
  openInterestValue: number;
  openInterestChangePct: number;
  longLiquidationUsd5m: number;
  shortLiquidationUsd5m: number;
  basisBps: number;
}

export interface OrderFlowState {
  aggressiveBuyUsd1m: number;
  aggressiveSellUsd1m: number;
  aggressiveBuyUsd5m: number;
  aggressiveSellUsd5m: number;
  topBookImbalance: number;
  depthImbalance5Bps: number;
  bookFragility: number;
  absorptionScore: number;
  bids: BookLevel[];
  asks: BookLevel[];
}

export interface CrossAssetState {
  healthy: boolean;
  ethSpot: number | null;
  ethAgeMs: number | null;
  ethReturn5mPct: number | null;
  ethReturn15mPct: number | null;
  btcReturn5mPct: number | null;
  btcReturn15mPct: number | null;
  relativeReturn5mPct: number | null;
  relativeReturn15mPct: number | null;
}

export interface MarketRegime {
  direction: 'strong_bull' | 'bull' | 'range' | 'bear' | 'strong_bear';
  volatility: 'compressed' | 'normal' | 'elevated' | 'extreme';
  liquidity: 'deep' | 'normal' | 'thin' | 'dislocated';
  positioning: 'long_crowded' | 'short_crowded' | 'neutral' | 'deleveraging';
  event: 'normal' | 'data_degraded' | 'liquidation_cascade';
  directionalScore: number;
  volatilityPercentile: number;
}

export interface MarketContext {
  timestamp: number;
  prices: PriceState;
  candles: {
    oneMinute: Candle[];
    fiveMinute: Candle[];
    fifteenMinute: Candle[];
    oneHour: Candle[];
    fourHour: Candle[];
  };
  derivatives: DerivativesState;
  orderFlow: OrderFlowState;
  crossAsset?: CrossAssetState;
  regime: MarketRegime;
  feed: FeedQuality;
}

export interface StrategyScores {
  signal: number;
  regime: number;
  execution: number;
  data: number;
}

export interface StrategyCandidate {
  id: string;
  strategyId: string;
  strategyVersion: string;
  strategyName: string;
  mode: StrategyMode;
  direction: BtcDirection;
  setupType: string;
  createdAt: number;
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
  minimumRR: number;
  strategyLeverageCap: number;
  expectedHoldingMinutes: number;
  exitModel: ExitModel;
  scores: StrategyScores;
  invalidationReasons: string[];
  rationale: string[];
  features: Record<string, number | string | boolean | null>;
}

export interface StrategyDefinition {
  id: string;
  version: string;
  name: string;
  description: string;
  mode: StrategyMode;
  leverageCap: number;
  evaluate(context: MarketContext): StrategyCandidate[];
}

export interface TradingCosts {
  entryFeeUsd: number;
  exitFeeUsd: number;
  entrySlippageUsd: number;
  exitSlippageUsd: number;
  spreadUsd: number;
  expectedFundingUsd: number;
  totalEstimatedUsd: number;
}

export interface StrategyExpectancyEvidence {
  resolvedCalls: number;
  requiredResolvedCalls: number;
  netPnlUsd: number;
  averageR: number | null;
  profitFactor: number | null;
  minimumAverageR: number;
  minimumProfitFactor: number;
  ready: boolean;
}

export interface RiskPlan {
  approved: boolean;
  rejectionReasons: string[];
  marginUsd: number;
  leverage: number;
  notionalUsd: number;
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  extendedTargetPrice: number | null;
  liquidationPrice: number;
  liquidationBufferPct: number;
  estimatedRiskUsd: number;
  estimatedRewardUsd: number;
  estimatedNetRR: number;
  estimatedTargetRoiPct: number;
  actionableTier?: ActionableAlertTier | null;
  expectancyEvidence?: StrategyExpectancyEvidence | null;
  costs: TradingCosts;
}

export interface PaperCall {
  id: string;
  book: CallBook;
  strategyId: string;
  strategyVersion: string;
  strategyName: string;
  supportingStrategies: string[];
  direction: BtcDirection;
  status: CallStatus;
  marginUsd: number;
  leverage: number;
  notionalUsd: number;
  entryPrice: number;
  currentPrice: number;
  stopPrice: number;
  targetPrice: number;
  extendedTargetPrice: number | null;
  liquidationPrice: number;
  confidence: number;
  openedAt: number;
  closedAt: number | null;
  exitPrice: number | null;
  exitReason: string | null;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  netPnlUsd: number;
  roiPct: number;
  currentR: number;
  resultR: number | null;
  maxFavorableR: number;
  maxAdverseR: number;
  remainingFraction: number;
  runnerActivated: boolean;
  trailingStopPrice: number | null;
  feesUsd: number;
  fundingUsd: number;
  entryAlertAt: number;
  simulatedFillAt: number;
  rationale: string[];
  features: Record<string, number | string | boolean | null>;
}

export interface PortfolioLimits {
  maxActiveActionableCalls: number;
  maxActiveResearchCallsPerStrategy: number;
  maxDailyActionableCalls: number;
  maxDailyNetLossUsd: number;
  maxTotalNotionalUsd: number;
  maxWeightedLeverage: number;
  maxLeverage: number;
}

export interface StrategyPerformance {
  strategyId: string;
  strategyVersion: string;
  strategyName: string;
  mode: StrategyMode;
  leverageCap: number;
  activeCalls: number;
  totalCalls: number;
  wins: number;
  losses: number;
  winRatePct: number | null;
  netPnlUsd: number;
  averageR: number | null;
  profitFactor: number | null;
}

export interface PlatformStatus {
  market: 'BTC-PERP';
  mode: 'paper';
  executionEnabled: false;
  referenceVenue: string;
  engineState: string;
  prices: PriceState | null;
  feed: FeedQuality;
  regime: MarketRegime | null;
  crossAsset: CrossAssetState | null;
  portfolio: {
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
  activeCalls: PaperCall[];
  recentCalls: PaperCall[];
  winners: PaperCall[];
  losers: PaperCall[];
  strategies: StrategyPerformance[];
  latestCandidates: StrategyCandidate[];
  blockers: string[];
  updatedAt: string;
}
