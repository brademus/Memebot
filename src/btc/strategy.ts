export const BTC_STRATEGY_VERSION = 'btc-momentum-v1.0.0';

export type BtcDirection = 'long' | 'short';

export interface BtcCandle {
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

export interface BtcFeedQuality {
  healthy: boolean;
  coinbaseAgeMs: number | null;
  krakenAgeMs: number | null;
  spreadBps: number | null;
  divergenceBps: number | null;
  recentSequenceGap: boolean;
  blockers: string[];
}

export interface BtcRegimeAssessment {
  direction: BtcDirection | null;
  longVotes: number;
  shortVotes: number;
  return12hPct: number;
  aboveVwap24h: boolean;
  oneHourSlopePct: number;
  fourHourSlopePct: number;
  atr15m: number;
  atrPct: number;
  blockers: string[];
}

export interface BtcImpulse {
  direction: BtcDirection;
  candleStartMs: number;
  expiresAtMs: number;
  high: number;
  low: number;
  range: number;
  atr15m: number;
  volumeRatio: number;
  rangeRatio: number;
  closeLocation: number;
  regimeVotes: number;
  retestTouched: boolean;
  retestExtreme: number | null;
}

export interface BtcEntryDecision {
  ready: boolean;
  direction: BtcDirection;
  entry: number | null;
  stop: number | null;
  target: number | null;
  riskReward: number;
  confidence: number;
  flowRatio: number;
  blockers: string[];
  nextImpulse: BtcImpulse | null;
}

export interface BtcStrategyParameters {
  minRegimeVotes: number;
  minAtrPct: number;
  maxAtrPct: number;
  minImpulseVolumeRatio: number;
  minImpulseRangeRatio: number;
  minCloseLocation: number;
  maxRetestMinutes: number;
  minRetestDepth: number;
  maxRetestDepth: number;
  minFlowRatio: number;
  maxSpreadBps: number;
  maxDivergenceBps: number;
  minRiskPct: number;
  maxRiskPct: number;
  targetR: number;
  stopAtrBuffer: number;
  minConfidence: number;
}

export const DEFAULT_BTC_STRATEGY_PARAMETERS: Readonly<BtcStrategyParameters> = Object.freeze({
  minRegimeVotes: 3,
  minAtrPct: 0.12,
  maxAtrPct: 1.6,
  minImpulseVolumeRatio: 1.4,
  minImpulseRangeRatio: 1.2,
  minCloseLocation: 0.75,
  maxRetestMinutes: 90,
  minRetestDepth: 0.25,
  maxRetestDepth: 0.68,
  minFlowRatio: 1.08,
  maxSpreadBps: 15,
  maxDivergenceBps: 25,
  minRiskPct: 0.15,
  maxRiskPct: 1.6,
  targetR: 2.5,
  stopAtrBuffer: 0.1,
  minConfidence: 78,
});

export function median(values: number[]): number {
  const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!finite.length) return 0;
  const middle = Math.floor(finite.length / 2);
  return finite.length % 2 ? finite[middle] : (finite[middle - 1] + finite[middle]) / 2;
}

export function averageTrueRange(candles: BtcCandle[], period = 14): number {
  const complete = candles.filter(candle => candle.complete);
  if (complete.length < period + 1) return 0;
  const sample = complete.slice(-(period + 1));
  const ranges: number[] = [];
  for (let index = 1; index < sample.length; index++) {
    const current = sample[index];
    const previous = sample[index - 1];
    ranges.push(Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close),
    ));
  }
  return ranges.reduce((sum, value) => sum + value, 0) / ranges.length;
}

export function rollingVwap(candles: BtcCandle[], count: number): number {
  const sample = candles.filter(candle => candle.complete).slice(-count);
  let numerator = 0;
  let denominator = 0;
  for (const candle of sample) {
    const typical = (candle.high + candle.low + candle.close) / 3;
    numerator += typical * candle.volume;
    denominator += candle.volume;
  }
  return denominator > 0 ? numerator / denominator : (sample.at(-1)?.close || 0);
}

export function assessBtcRegime(
  oneHour: BtcCandle[],
  fourHour: BtcCandle[],
  fifteenMinute: BtcCandle[],
  params: BtcStrategyParameters = DEFAULT_BTC_STRATEGY_PARAMETERS,
): BtcRegimeAssessment {
  const hour = oneHour.filter(candle => candle.complete);
  const four = fourHour.filter(candle => candle.complete);
  const blockers: string[] = [];
  if (hour.length < 25) blockers.push('need at least 25 complete one-hour candles');
  if (four.length < 5) blockers.push('need at least 5 complete four-hour candles');
  if (fifteenMinute.filter(candle => candle.complete).length < 20) blockers.push('need at least 20 complete fifteen-minute candles');
  const latest = hour.at(-1);
  if (!latest || blockers.length) {
    return {
      direction: null, longVotes: 0, shortVotes: 0, return12hPct: 0,
      aboveVwap24h: false, oneHourSlopePct: 0, fourHourSlopePct: 0,
      atr15m: 0, atrPct: 0, blockers,
    };
  }

  const returnBase = hour.at(-13)?.close || latest.close;
  const oneHourBase = hour.at(-7)?.close || latest.close;
  const fourHourBase = four.at(-4)?.close || latest.close;
  const return12hPct = returnBase > 0 ? ((latest.close / returnBase) - 1) * 100 : 0;
  const oneHourSlopePct = oneHourBase > 0 ? ((latest.close / oneHourBase) - 1) * 100 : 0;
  const fourHourSlopePct = fourHourBase > 0 ? ((four.at(-1)!.close / fourHourBase) - 1) * 100 : 0;
  const vwap24h = rollingVwap(hour, 24);
  const aboveVwap24h = latest.close >= vwap24h;
  const atr15m = averageTrueRange(fifteenMinute, 14);
  const atrPct = latest.close > 0 ? (atr15m / latest.close) * 100 : 0;

  const bullish = [return12hPct > 0, oneHourSlopePct > 0, fourHourSlopePct > 0, aboveVwap24h];
  const bearish = [return12hPct < 0, oneHourSlopePct < 0, fourHourSlopePct < 0, !aboveVwap24h];
  const longVotes = bullish.filter(Boolean).length;
  const shortVotes = bearish.filter(Boolean).length;
  let direction: BtcDirection | null = null;
  if (longVotes >= params.minRegimeVotes && longVotes > shortVotes) direction = 'long';
  if (shortVotes >= params.minRegimeVotes && shortVotes > longVotes) direction = 'short';

  if (!direction) blockers.push('higher-timeframe regime is mixed');
  if (!(atrPct >= params.minAtrPct)) blockers.push('volatility is below the tradable floor');
  if (!(atrPct <= params.maxAtrPct)) blockers.push('volatility is above the crisis ceiling');
  if (blockers.some(reason => reason.includes('volatility'))) direction = null;

  return {
    direction, longVotes, shortVotes, return12hPct, aboveVwap24h,
    oneHourSlopePct, fourHourSlopePct, atr15m, atrPct, blockers,
  };
}

export function detectBtcImpulse(
  fifteenMinute: BtcCandle[],
  regime: BtcRegimeAssessment,
  nowMs: number,
  params: BtcStrategyParameters = DEFAULT_BTC_STRATEGY_PARAMETERS,
): { impulse: BtcImpulse | null; blockers: string[] } {
  const complete = fifteenMinute.filter(candle => candle.complete);
  const latest = complete.at(-1);
  const blockers: string[] = [];
  if (!regime.direction) blockers.push(...regime.blockers);
  if (!latest || complete.length < 34) blockers.push('not enough fifteen-minute history for the volume baseline');
  if (!latest || blockers.length) return { impulse: null, blockers };

  const priorVolumes = complete.slice(-33, -1).map(candle => candle.volume).filter(value => value > 0);
  const volumeBaseline = median(priorVolumes);
  const range = latest.high - latest.low;
  const volumeRatio = volumeBaseline > 0 ? latest.volume / volumeBaseline : 0;
  const rangeRatio = regime.atr15m > 0 ? range / regime.atr15m : 0;
  const closeLocation = range > 0 ? (latest.close - latest.low) / range : 0.5;
  const directionMatches = regime.direction === 'long'
    ? latest.close > latest.open && closeLocation >= params.minCloseLocation
    : latest.close < latest.open && closeLocation <= 1 - params.minCloseLocation;

  if (!directionMatches) blockers.push('latest fifteen-minute candle does not close with the regime');
  if (volumeRatio < params.minImpulseVolumeRatio) blockers.push('impulse volume is below baseline');
  if (rangeRatio < params.minImpulseRangeRatio) blockers.push('impulse range is below the ATR threshold');
  if (blockers.length) return { impulse: null, blockers };

  return {
    blockers: [],
    impulse: {
      direction: regime.direction!,
      candleStartMs: latest.startMs,
      expiresAtMs: latest.startMs + (15 + params.maxRetestMinutes) * 60_000,
      high: latest.high,
      low: latest.low,
      range,
      atr15m: regime.atr15m,
      volumeRatio,
      rangeRatio,
      closeLocation,
      regimeVotes: regime.direction === 'long' ? regime.longVotes : regime.shortVotes,
      retestTouched: false,
      retestExtreme: null,
    },
  };
}

function directionalFlowRatio(candle: BtcCandle, direction: BtcDirection): number {
  const aligned = direction === 'long' ? candle.buyVolume : candle.sellVolume;
  const opposed = direction === 'long' ? candle.sellVolume : candle.buyVolume;
  if (aligned <= 0 && opposed <= 0) return 0;
  return aligned / Math.max(opposed, 1e-12);
}

function confidenceForEntry(
  impulse: BtcImpulse,
  flowRatio: number,
  feed: BtcFeedQuality,
  riskPct: number,
): number {
  let score = 0;
  score += Math.min(20, impulse.regimeVotes * 5);
  score += Math.min(20, 10 + (impulse.volumeRatio - 1) * 10);
  score += Math.min(18, 8 + (impulse.rangeRatio - 1) * 10);
  const directionalClose = impulse.direction === 'long' ? impulse.closeLocation : 1 - impulse.closeLocation;
  score += Math.min(15, directionalClose * 15);
  score += Math.min(17, Math.max(0, (flowRatio - 1) * 20 + 7));
  score += feed.healthy ? 10 : 0;
  if (riskPct > 1.2) score -= 5;
  return Math.max(0, Math.min(100, Math.round(score)));
}

export function evaluateBtcRetest(
  impulse: BtcImpulse,
  fiveMinute: BtcCandle[],
  feed: BtcFeedQuality,
  nowMs: number,
  params: BtcStrategyParameters = DEFAULT_BTC_STRATEGY_PARAMETERS,
): BtcEntryDecision {
  const bars = fiveMinute.filter(candle => candle.complete && candle.startMs > impulse.candleStartMs);
  const latest = bars.at(-1);
  const previous = bars.at(-2);
  const blockers: string[] = [];
  let nextImpulse = { ...impulse };

  if (nowMs > impulse.expiresAtMs) blockers.push('retest window expired');
  if (!latest || !previous) blockers.push('waiting for two complete five-minute bars after the impulse');
  if (!feed.healthy) blockers.push(...feed.blockers);
  if (!latest || !previous || blockers.some(reason => reason === 'retest window expired')) {
    return { ready: false, direction: impulse.direction, entry: null, stop: null, target: null, riskReward: params.targetR, confidence: 0, flowRatio: 0, blockers, nextImpulse: blockers.includes('retest window expired') ? null : nextImpulse };
  }

  const floor = impulse.low + impulse.range * (1 - params.maxRetestDepth);
  const ceiling = impulse.low + impulse.range * (1 - params.minRetestDepth);
  const intersectsZone = latest.low <= ceiling && latest.high >= floor;
  if (intersectsZone) {
    nextImpulse.retestTouched = true;
    nextImpulse.retestExtreme = impulse.direction === 'long'
      ? Math.min(nextImpulse.retestExtreme ?? latest.low, latest.low)
      : Math.max(nextImpulse.retestExtreme ?? latest.high, latest.high);
  }

  const invalidated = impulse.direction === 'long'
    ? latest.low < impulse.low - impulse.atr15m * params.stopAtrBuffer
    : latest.high > impulse.high + impulse.atr15m * params.stopAtrBuffer;
  if (invalidated) blockers.push('impulse structure invalidated');
  if (!nextImpulse.retestTouched) blockers.push('waiting for a controlled retest');

  const confirmation = impulse.direction === 'long'
    ? latest.close > previous.close && latest.close >= impulse.low + impulse.range * 0.7
    : latest.close < previous.close && latest.close <= impulse.high - impulse.range * 0.7;
  if (!confirmation) blockers.push('waiting for five-minute continuation confirmation');

  const flowRatio = directionalFlowRatio(latest, impulse.direction);
  if (flowRatio < params.minFlowRatio) blockers.push('live order flow does not confirm the direction');
  if (feed.spreadBps === null || feed.spreadBps > params.maxSpreadBps) blockers.push('spread is outside the entry limit');
  if (feed.divergenceBps === null || feed.divergenceBps > params.maxDivergenceBps) blockers.push('cross-exchange price divergence is outside the limit');
  if (invalidated || blockers.length) {
    return { ready: false, direction: impulse.direction, entry: null, stop: null, target: null, riskReward: params.targetR, confidence: 0, flowRatio, blockers, nextImpulse: invalidated ? null : nextImpulse };
  }

  const entry = latest.close;
  const retestExtreme = nextImpulse.retestExtreme ?? (impulse.direction === 'long' ? latest.low : latest.high);
  const stop = impulse.direction === 'long'
    ? Math.min(retestExtreme, impulse.low) - impulse.atr15m * params.stopAtrBuffer
    : Math.max(retestExtreme, impulse.high) + impulse.atr15m * params.stopAtrBuffer;
  const risk = Math.abs(entry - stop);
  const riskPct = entry > 0 ? (risk / entry) * 100 : 0;
  if (riskPct < params.minRiskPct) blockers.push('stop distance is below the market-noise floor');
  if (riskPct > params.maxRiskPct) blockers.push('stop distance exceeds the risk ceiling');
  const target = impulse.direction === 'long' ? entry + risk * params.targetR : entry - risk * params.targetR;
  const confidence = confidenceForEntry(impulse, flowRatio, feed, riskPct);
  if (confidence < params.minConfidence) blockers.push(`confidence ${confidence} is below ${params.minConfidence}`);

  return {
    ready: blockers.length === 0,
    direction: impulse.direction,
    entry,
    stop,
    target,
    riskReward: params.targetR,
    confidence,
    flowRatio,
    blockers,
    nextImpulse,
  };
}

export function aggregateCandles(source: BtcCandle[], timeframeSec: number): BtcCandle[] {
  const buckets = new Map<number, BtcCandle>();
  const bucketMs = timeframeSec * 1000;
  for (const candle of source.filter(item => item.complete).sort((a, b) => a.startMs - b.startMs)) {
    const startMs = Math.floor(candle.startMs / bucketMs) * bucketMs;
    const existing = buckets.get(startMs);
    if (!existing) {
      buckets.set(startMs, {
        timeframeSec, startMs, open: candle.open, high: candle.high, low: candle.low,
        close: candle.close, volume: candle.volume, tradeCount: candle.tradeCount,
        buyVolume: candle.buyVolume, sellVolume: candle.sellVolume, complete: true,
      });
      continue;
    }
    existing.high = Math.max(existing.high, candle.high);
    existing.low = Math.min(existing.low, candle.low);
    existing.close = candle.close;
    existing.volume += candle.volume;
    existing.tradeCount += candle.tradeCount;
    existing.buyVolume += candle.buyVolume;
    existing.sellVolume += candle.sellVolume;
  }
  return [...buckets.values()].sort((a, b) => a.startMs - b.startMs);
}
