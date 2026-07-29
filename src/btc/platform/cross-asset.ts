import { Candle, CrossAssetState } from './types';

export interface TimedPrice {
  at: number;
  price: number;
}

function returnSince(observations: readonly TimedPrice[], current: number | null, milliseconds: number, now: number): number | null {
  if (!current || current <= 0 || !observations.length) return null;
  const target = now - milliseconds;
  const base = [...observations].reverse().find(observation => observation.at <= target);
  if (!base || base.price <= 0) return null;
  return (current / base.price - 1) * 100;
}

function candleReturnSince(candles: readonly Candle[], current: number, milliseconds: number, now: number): number | null {
  const target = now - milliseconds;
  const base = [...candles].reverse().find(candle => candle.startMs <= target && candle.close > 0);
  if (!base) return null;
  return (current / base.close - 1) * 100;
}

export function buildCrossAssetState(input: {
  now: number;
  currentBtc: number;
  btcOneMinuteCandles: readonly Candle[];
  currentEth: number | null;
  ethObservations: readonly TimedPrice[];
  latestEthAt: number | null;
  maxEthAgeMs?: number;
}): CrossAssetState {
  const maxEthAgeMs = input.maxEthAgeMs ?? 15_000;
  const ethAgeMs = input.latestEthAt === null ? null : input.now - input.latestEthAt;
  const ethReturn5mPct = returnSince(input.ethObservations, input.currentEth, 5 * 60_000, input.now);
  const ethReturn15mPct = returnSince(input.ethObservations, input.currentEth, 15 * 60_000, input.now);
  const btcReturn5mPct = candleReturnSince(input.btcOneMinuteCandles, input.currentBtc, 5 * 60_000, input.now);
  const btcReturn15mPct = candleReturnSince(input.btcOneMinuteCandles, input.currentBtc, 15 * 60_000, input.now);
  const relativeReturn5mPct = ethReturn5mPct !== null && btcReturn5mPct !== null
    ? ethReturn5mPct - btcReturn5mPct : null;
  const relativeReturn15mPct = ethReturn15mPct !== null && btcReturn15mPct !== null
    ? ethReturn15mPct - btcReturn15mPct : null;
  const healthy = ethAgeMs !== null && ethAgeMs >= 0 && ethAgeMs < maxEthAgeMs
    && ethReturn5mPct !== null && ethReturn15mPct !== null
    && btcReturn5mPct !== null && btcReturn15mPct !== null;
  return {
    healthy,
    ethSpot: input.currentEth,
    ethAgeMs,
    ethReturn5mPct,
    ethReturn15mPct,
    btcReturn5mPct,
    btcReturn15mPct,
    relativeReturn5mPct,
    relativeReturn15mPct,
  };
}
