import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCrossAssetState, TimedPrice } from './cross-asset';
import { Candle } from './types';

const now = 1_800_000;
const eth: TimedPrice[] = Array.from({ length: 21 }, (_, index) => ({
  at: now - (20 - index) * 60_000,
  price: 3_400 + index * 4,
}));
const btc: Candle[] = Array.from({ length: 21 }, (_, index) => ({
  timeframeSec: 60,
  startMs: now - (20 - index) * 60_000,
  open: 99_000 + index * 20,
  high: 99_020 + index * 20,
  low: 98_980 + index * 20,
  close: 99_000 + index * 20,
  volume: 1,
  tradeCount: 1,
  buyVolume: 0.6,
  sellVolume: 0.4,
  complete: true,
}));

test('cross-asset state calculates rolling ETH lead over BTC', () => {
  const state = buildCrossAssetState({
    now,
    currentBtc: 99_400,
    btcOneMinuteCandles: btc,
    currentEth: 3_520,
    ethObservations: eth,
    latestEthAt: now - 100,
  });
  assert.equal(state.healthy, true);
  assert.ok(state.ethReturn5mPct !== null && state.btcReturn5mPct !== null);
  if (state.relativeReturn5mPct === null || state.relativeReturn15mPct === null) throw new Error('expected rolling relative returns');
  assert.ok(state.relativeReturn5mPct > 0);
  assert.ok(state.relativeReturn15mPct > 0);
});

test('cross-asset state is unhealthy when ETH is stale without discarding calculated history', () => {
  const state = buildCrossAssetState({
    now,
    currentBtc: 99_400,
    btcOneMinuteCandles: btc,
    currentEth: 3_520,
    ethObservations: eth,
    latestEthAt: now - 30_000,
  });
  assert.equal(state.healthy, false);
  assert.ok(state.relativeReturn5mPct !== null);
});
