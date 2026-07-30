import assert from 'node:assert/strict';
import test from 'node:test';
import { BTC_STRATEGIES } from './strategy-registry';

const expected = new Map<string, { version: string; leverageCap: number; mode: 'actionable' | 'shadow' }>([
  ['btc-momentum-retest', { version: '3.0.0', leverageCap: 10, mode: 'actionable' }],
  ['btc-compression-breakout', { version: '2.0.0', leverageCap: 10, mode: 'actionable' }],
  ['btc-orderflow-absorption', { version: '0.4.0-shadow', leverageCap: 8, mode: 'shadow' }],
  ['btc-cvd-divergence', { version: '0.3.0-shadow', leverageCap: 8, mode: 'shadow' }],
  ['btc-adaptive-trend-rider', { version: '2.0.0', leverageCap: 10, mode: 'actionable' }],
]);

test('market-aligned BTC redesign remains independently versioned with reduced leverage', () => {
  for (const [strategyId, contract] of expected) {
    const strategy = BTC_STRATEGIES.find(item => item.id === strategyId);
    assert.ok(strategy, `${strategyId} is missing from the strategy registry`);
    assert.equal(strategy.version, contract.version, `${strategyId} version changed without a new evidence cohort`);
    assert.equal(strategy.leverageCap, contract.leverageCap, `${strategyId} leverage cap regressed`);
    assert.equal(strategy.mode, contract.mode, `${strategyId} mode changed`);
  }
});
