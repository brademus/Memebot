import { Candle, MarketContext, MarketRegime } from './types';

export const clamp = (value: number, low: number, high: number): number => Math.max(low, Math.min(high, value));
export const safeDiv = (numerator: number, denominator: number, fallback = 0): number => denominator ? numerator / denominator : fallback;
export const pct = (from: number, to: number): number => from > 0 ? ((to / from) - 1) * 100 : 0;

export function median(values: number[]): number {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function mean(values: number[]): number {
  const finite = values.filter(Number.isFinite);
  return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : 0;
}

export function standardDeviation(values: number[]): number {
  const finite = values.filter(Number.isFinite);
  if (finite.length < 2) return 0;
  const average = mean(finite);
  return Math.sqrt(mean(finite.map(value => (value - average) ** 2)));
}

export function averageTrueRange(candles: Candle[], period = 14): number {
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
  return mean(ranges);
}

export function rollingVwap(candles: Candle[], count: number): number {
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

export function realizedVolatilityPct(candles: Candle[], count: number): number {
  const closes = candles.filter(candle => candle.complete).slice(-(count + 1)).map(candle => candle.close);
  if (closes.length < 3) return 0;
  const returns: number[] = [];
  for (let index = 1; index < closes.length; index++) {
    if (closes[index - 1] > 0 && closes[index] > 0) returns.push(Math.log(closes[index] / closes[index - 1]));
  }
  return standardDeviation(returns) * Math.sqrt(Math.max(returns.length, 1)) * 100;
}

export function percentileRank(values: number[], value: number): number {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return 50;
  return (finite.filter(candidate => candidate <= value).length / finite.length) * 100;
}

export function directionalEfficiency(candles: Candle[], count: number): number {
  const sample = candles.filter(candle => candle.complete).slice(-(count + 1));
  if (sample.length < 3) return 0;
  const net = Math.abs(sample.at(-1)!.close - sample[0].close);
  let path = 0;
  for (let index = 1; index < sample.length; index++) path += Math.abs(sample[index].close - sample[index - 1].close);
  return clamp(safeDiv(net, path), 0, 1);
}

export function zScore(values: number[], value: number): number {
  const average = mean(values);
  const deviation = standardDeviation(values);
  return deviation > 0 ? (value - average) / deviation : 0;
}

export function rangePosition(candles: Candle[], count: number, price: number): number {
  const sample = candles.filter(candle => candle.complete).slice(-count);
  if (!sample.length) return 0.5;
  const low = Math.min(...sample.map(candle => candle.low));
  const high = Math.max(...sample.map(candle => candle.high));
  return clamp(safeDiv(price - low, high - low, 0.5), 0, 1);
}

export function compressionScore(candles: Candle[]): number {
  const complete = candles.filter(candle => candle.complete);
  if (complete.length < 40) return 0;
  const recent = complete.slice(-8);
  const baseline = complete.slice(-40, -8);
  const recentRanges = recent.map(candle => safeDiv(candle.high - candle.low, candle.close));
  const baselineRanges = baseline.map(candle => safeDiv(candle.high - candle.low, candle.close));
  const ratio = safeDiv(mean(recentRanges), median(baselineRanges), 1);
  return clamp((1.25 - ratio) / 0.75, 0, 1);
}

export function classifyRegime(context: Omit<MarketContext, 'regime'>): MarketRegime {
  const oneHour = context.candles.oneHour.filter(candle => candle.complete);
  const fourHour = context.candles.fourHour.filter(candle => candle.complete);
  const latest = context.prices.mark || context.prices.last;
  const h1Base = oneHour.at(-7)?.close || latest;
  const h4Base = fourHour.at(-4)?.close || latest;
  const h1Momentum = pct(h1Base, latest);
  const h4Momentum = pct(h4Base, latest);
  const vwap = rollingVwap(oneHour, 24);
  const efficiency = directionalEfficiency(context.candles.fifteenMinute, 24);
  const directionalScore = clamp(
    h1Momentum * 10 + h4Momentum * 6 + (latest >= vwap ? 12 : -12) + (efficiency - 0.35) * 40,
    -100,
    100,
  );

  let direction: MarketRegime['direction'] = 'range';
  if (directionalScore >= 50) direction = 'strong_bull';
  else if (directionalScore >= 18) direction = 'bull';
  else if (directionalScore <= -50) direction = 'strong_bear';
  else if (directionalScore <= -18) direction = 'bear';

  const currentAtrPct = safeDiv(averageTrueRange(context.candles.fifteenMinute, 14), latest) * 100;
  const history = context.candles.fifteenMinute.filter(candle => candle.complete);
  const historicalAtrPcts: number[] = [];
  for (let end = 20; end <= history.length; end += 4) {
    const sample = history.slice(0, end);
    const close = sample.at(-1)?.close || latest;
    historicalAtrPcts.push(safeDiv(averageTrueRange(sample, 14), close) * 100);
  }
  const volatilityPercentile = percentileRank(historicalAtrPcts.slice(-100), currentAtrPct);
  let volatility: MarketRegime['volatility'] = 'normal';
  if (volatilityPercentile < 20 || compressionScore(context.candles.fifteenMinute) > 0.7) volatility = 'compressed';
  else if (volatilityPercentile >= 90) volatility = 'extreme';
  else if (volatilityPercentile >= 70) volatility = 'elevated';

  const spread = context.feed.spreadBps ?? 999;
  const depthUsd = context.orderFlow.bids.slice(0, 5).reduce((sum, level) => sum + level.price * level.size, 0)
    + context.orderFlow.asks.slice(0, 5).reduce((sum, level) => sum + level.price * level.size, 0);
  let liquidity: MarketRegime['liquidity'] = 'normal';
  if (!context.feed.healthy || spread > 12 || context.orderFlow.bookFragility > 0.8) liquidity = 'dislocated';
  else if (spread > 5 || depthUsd < 250_000) liquidity = 'thin';
  else if (spread < 1.5 && depthUsd > 2_000_000) liquidity = 'deep';

  const funding = context.derivatives.fundingRate;
  const oiChange = context.derivatives.openInterestChangePct;
  let positioning: MarketRegime['positioning'] = 'neutral';
  if (funding > 0.0005 && oiChange > 0.5) positioning = 'long_crowded';
  else if (funding < -0.0005 && oiChange > 0.5) positioning = 'short_crowded';
  else if (oiChange < -2 || context.derivatives.longLiquidationUsd5m + context.derivatives.shortLiquidationUsd5m > 10_000_000) positioning = 'deleveraging';

  let event: MarketRegime['event'] = 'normal';
  if (!context.feed.healthy) event = 'data_degraded';
  else if (
    context.derivatives.longLiquidationUsd5m + context.derivatives.shortLiquidationUsd5m > 5_000_000
    || volatility === 'extreme'
  ) event = 'liquidation_cascade';

  return { direction, volatility, liquidity, positioning, event, directionalScore, volatilityPercentile };
}
