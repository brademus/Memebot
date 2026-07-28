import test from 'node:test';
import assert from 'node:assert/strict';
import {
  adaptiveExitDecision,
  benchmarkExitDecision,
  deteriorationFamiliesFromSignals,
  strategyRoleForSignal,
  StrategyExitInput,
} from './strategy-policy';

const healthy = (overrides: Partial<StrategyExitInput> = {}): StrategyExitInput => ({
  role: 'timed_entry',
  entryPrice: 1,
  markPrice: 1.2,
  peakPrice: 1.25,
  ageHours: 1,
  entryScore: 70,
  currentScore: 68,
  entryLiquidityUsd: 50_000,
  currentLiquidityUsd: 48_000,
  buys5m: 20,
  sells5m: 10,
  priceChange5m: 4,
  entrySmartWallets: 2,
  currentSmartWallets: 2,
  earlyRetention: 0.8,
  modelExpectedValue: 0.12,
  modelDownsideProbability: 0.25,
  state: 'TRIGGER',
  insiderKilled: false,
  fundedSnipers: 0,
  ...overrides,
});

test('strategy roles separate quality observations from timed purchases', () => {
  assert.equal(strategyRoleForSignal('bb_organic'), 'quality_observation');
  assert.equal(strategyRoleForSignal('bb_smart'), 'quality_observation');
  assert.equal(strategyRoleForSignal('trigger'), 'timed_entry');
  assert.equal(strategyRoleForSignal('model_raw'), 'model_observation');
});

test('healthy timed entry remains open with an explainable hold decision', () => {
  const result = adaptiveExitDecision(healthy());
  assert.equal(result.action, 'hold');
  assert.equal(result.reasonCode, 'strategy_hold');
  assert.equal(result.deteriorationSignals.length, 0);
});

test('3x and 50 percent boundaries preserve the hard policy limits', () => {
  const target = adaptiveExitDecision(healthy({ markPrice: 2.9, peakPrice: 3.1 }));
  assert.equal(target.action, 'sell');
  assert.equal(target.reasonCode, 'strategy_take_profit_3x');
  assert.equal(target.exitPrice, 3);

  const stop = adaptiveExitDecision(healthy({ markPrice: 0.49, peakPrice: 1.1 }));
  assert.equal(stop.action, 'sell');
  assert.equal(stop.reasonCode, 'strategy_hard_stop_50pct');
  assert.equal(stop.exitPrice, 0.5);
});

test('profit protection exits after a strong run reverses', () => {
  const result = adaptiveExitDecision(healthy({ markPrice: 1.45, peakPrice: 2.05 }));
  assert.equal(result.action, 'sell');
  assert.equal(result.reasonCode, 'strategy_trailing_profit_exit_2x');
  assert.ok(result.activeStopMultiple >= 1.35);
});

test('multiple independent deterioration families can exit before the hard stop', () => {
  const result = adaptiveExitDecision(healthy({
    markPrice: 0.82,
    peakPrice: 1.1,
    currentScore: 48,
    currentLiquidityUsd: 32_000,
    buys5m: 4,
    sells5m: 12,
    currentSmartWallets: 0,
    earlyRetention: 0.4,
    modelExpectedValue: -0.1,
    modelDownsideProbability: 0.65,
    state: 'DYING',
    priceChange5m: -30,
  }));
  assert.equal(result.action, 'sell');
  assert.equal(result.reasonCode, 'strategy_multi_signal_deterioration_exit');
  assert.ok(Number(result.metrics.independentDeteriorationFamilyCount) >= 3);
});

test('correlated model outputs count as one evidence family and do not force an early winner exit', () => {
  const result = adaptiveExitDecision(healthy({
    markPrice: 1.24,
    peakPrice: 1.26,
    modelExpectedValue: -0.08,
    modelDownsideProbability: 0.61,
  }));
  assert.equal(result.action, 'hold');
  assert.deepEqual(result.metrics.deteriorationFamilies, ['model']);
  assert.equal(result.deteriorationSignals.length, 2);
});

test('derived DYING state is not counted twice with its score cause', () => {
  const result = adaptiveExitDecision(healthy({
    markPrice: 1.2,
    peakPrice: 1.22,
    currentScore: 48,
    state: 'DYING',
  }));
  assert.equal(result.action, 'hold');
  assert.deepEqual(result.metrics.deteriorationFamilies, ['score_quality']);
});

test('two genuine families may protect an extreme winner or loser', () => {
  const result = adaptiveExitDecision(healthy({
    markPrice: 0.82,
    peakPrice: 1.02,
    currentScore: 48,
    buys5m: 4,
    sells5m: 12,
    state: 'DYING',
  }));
  assert.equal(result.action, 'sell');
  assert.deepEqual(result.metrics.deteriorationFamilies, ['market_flow', 'score_quality']);
});

test('three independent families exit near breakeven without relying on correlation', () => {
  const result = adaptiveExitDecision(healthy({
    markPrice: 0.98,
    peakPrice: 1.08,
    currentScore: 48,
    currentLiquidityUsd: 35_000,
    currentSmartWallets: 0,
  }));
  assert.equal(result.action, 'sell');
  assert.deepEqual(result.metrics.deteriorationFamilies, ['score_quality', 'liquidity', 'smart_wallet']);
});

test('family helper suppresses state when a direct causal measurement is present', () => {
  assert.deepEqual(deteriorationFamiliesFromSignals([
    'score deteriorated 20.0 points from entry',
    'token state changed to DYING',
    'model expected value turned negative (-0.100)',
    'model downside probability rose to 65.0%',
  ]), ['score_quality', 'model']);
});

test('quality observations use a fixed benchmark and are not adaptive purchases', () => {
  const collecting = benchmarkExitDecision(1, 1.2, 1.4, 3);
  assert.equal(collecting.action, 'hold');
  assert.equal(collecting.reasonCode, 'benchmark_collecting');

  const target = benchmarkExitDecision(1, 2.8, 3.2, 4);
  assert.equal(target.action, 'sell');
  assert.equal(target.reasonCode, 'benchmark_take_profit_3x');
});

test('post-exit shadows are quality observations, never trades', async () => {
  const { strategyRoleForSignal } = await import('./strategy-policy');
  assert.equal(strategyRoleForSignal('post_exit_watch'), 'quality_observation');
});
