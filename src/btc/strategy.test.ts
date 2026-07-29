import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BtcCandle,
  DEFAULT_BTC_STRATEGY_PARAMETERS,
  aggregateCandles,
  assessBtcRegime,
  detectBtcImpulse,
  evaluateBtcRetest,
} from './strategy';

function candle(timeframeSec: number, startMs: number, open: number, close: number, volume = 100, extras: Partial<BtcCandle> = {}): BtcCandle {
  return {
    timeframeSec,
    startMs,
    open,
    high: Math.max(open, close) + 10,
    low: Math.min(open, close) - 10,
    close,
    volume,
    tradeCount: 10,
    buyVolume: 60,
    sellVolume: 40,
    complete: true,
    ...extras,
  };
}

const base = 1_700_000_000_000;

test('regime requires broad directional agreement and valid volatility', () => {
  const hours = Array.from({ length: 30 }, (_, index) => candle(3600, base + index * 3_600_000, 50_000 + index * 100, 50_080 + index * 100, 1_000));
  const fourHours = aggregateCandles(hours, 14_400);
  const fifteen = Array.from({ length: 40 }, (_, index) => candle(900, base + index * 900_000, 52_000 + index * 10, 52_020 + index * 10, 250, { high: 52_100 + index * 10, low: 51_950 + index * 10 }));
  const regime = assessBtcRegime(hours, fourHours, fifteen);
  assert.equal(regime.direction, 'long');
  assert.ok(regime.longVotes >= 3);
});

test('impulse rejects ordinary volume and accepts a high-volume directional expansion', () => {
  const hours = Array.from({ length: 30 }, (_, index) => candle(3600, base + index * 3_600_000, 50_000 + index * 100, 50_080 + index * 100, 1_000));
  const fourHours = aggregateCandles(hours, 14_400);
  const fifteen = Array.from({ length: 40 }, (_, index) => candle(900, base + index * 900_000, 52_000 + index * 10, 52_020 + index * 10, 200, { high: 52_100 + index * 10, low: 51_950 + index * 10 }));
  const regime = assessBtcRegime(hours, fourHours, fifteen);
  assert.equal(detectBtcImpulse(fifteen, regime, base).impulse, null);

  const last = fifteen.at(-1)!;
  last.open = 52_000;
  last.low = 51_980;
  last.high = 52_500;
  last.close = 52_470;
  last.volume = 600;
  const found = detectBtcImpulse(fifteen, assessBtcRegime(hours, fourHours, fifteen), base);
  assert.equal(found.impulse?.direction, 'long');
});

test('retest produces a fixed-R paper call only with healthy feeds', () => {
  const impulse = {
    direction: 'long' as const,
    candleStartMs: base,
    expiresAtMs: base + 105 * 60_000,
    high: 50_500,
    low: 50_000,
    range: 500,
    atr15m: 250,
    volumeRatio: 2,
    rangeRatio: 2,
    closeLocation: 0.94,
    regimeVotes: 4,
    retestTouched: false,
    retestExtreme: null,
  };
  const bars = [
    candle(300, base + 20 * 60_000, 50_450, 50_260, 120, { low: 50_180, high: 50_470, buyVolume: 55, sellVolume: 45 }),
    candle(300, base + 25 * 60_000, 50_260, 50_390, 150, { low: 50_220, high: 50_410, buyVolume: 90, sellVolume: 40 }),
  ];
  const feed = { healthy: true, coinbaseAgeMs: 1000, krakenAgeMs: 5000, spreadBps: 1, divergenceBps: 2, recentSequenceGap: false, blockers: [] };
  const result = evaluateBtcRetest(impulse, bars, feed, base + 30 * 60_000, { ...DEFAULT_BTC_STRATEGY_PARAMETERS, minConfidence: 70 });
  assert.equal(result.ready, true);
  assert.ok(result.entry && result.stop && result.target);
  assert.equal(Math.round(((result.target! - result.entry!) / (result.entry! - result.stop!)) * 10) / 10, 2.5);
});

test('cross-exchange feed disagreement blocks an otherwise valid entry', () => {
  const impulse = {
    direction: 'long' as const,
    candleStartMs: base,
    expiresAtMs: base + 105 * 60_000,
    high: 50_500,
    low: 50_000,
    range: 500,
    atr15m: 250,
    volumeRatio: 2,
    rangeRatio: 2,
    closeLocation: 0.94,
    regimeVotes: 4,
    retestTouched: false,
    retestExtreme: null,
  };
  const bars = [
    candle(300, base + 20 * 60_000, 50_450, 50_260, 120, { low: 50_180, high: 50_470, buyVolume: 55, sellVolume: 45 }),
    candle(300, base + 25 * 60_000, 50_260, 50_390, 150, { low: 50_220, high: 50_410, buyVolume: 90, sellVolume: 40 }),
  ];
  const feed = { healthy: false, coinbaseAgeMs: 1000, krakenAgeMs: 5000, spreadBps: 1, divergenceBps: 80, recentSequenceGap: false, blockers: ['cross-exchange divergence is too high'] };
  const result = evaluateBtcRetest(impulse, bars, feed, base + 30 * 60_000);
  assert.equal(result.ready, false);
  assert.ok(result.blockers.some(reason => reason.includes('divergence')));
});
