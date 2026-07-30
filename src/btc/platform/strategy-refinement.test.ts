import assert from 'node:assert/strict';
import test from 'node:test';
import { BTC_STRATEGIES } from './strategy-registry';

function strategy(id: string) {
  const found = BTC_STRATEGIES.find(item => item.id === id);
  if (!found) throw new Error(`missing strategy ${id}`);
  return found;
}

test('failed BTC models restart under market-aligned versions and lower leverage caps', () => {
  assert.equal(strategy('btc-momentum-retest').version, '3.0.0');
  assert.equal(strategy('btc-momentum-retest').leverageCap, 10);
  assert.equal(strategy('btc-compression-breakout').version, '2.0.0');
  assert.equal(strategy('btc-compression-breakout').leverageCap, 10);
  assert.equal(strategy('btc-orderflow-absorption').version, '0.4.0-shadow');
  assert.equal(strategy('btc-orderflow-absorption').leverageCap, 8);
  assert.equal(strategy('btc-cvd-divergence').version, '0.3.0-shadow');
  assert.equal(strategy('btc-cvd-divergence').leverageCap, 8);
  assert.equal(strategy('btc-adaptive-trend-rider').version, '2.0.0');
  assert.equal(strategy('btc-adaptive-trend-rider').leverageCap, 10);
  assert.equal(strategy('btc-perp-premium-convergence').version, '2.0.0');
  assert.equal(strategy('btc-perp-premium-convergence').leverageCap, 12);
});
