import assert from 'node:assert/strict';
import test from 'node:test';
import { BTC_STRATEGIES } from './strategy-registry';

function strategy(id: string) {
  const found = BTC_STRATEGIES.find(item => item.id === id);
  if (!found) throw new Error(`missing strategy ${id}`);
  return found;
}

test('failed first-iteration BTC strategies restart under refined versions and lower leverage caps', () => {
  assert.equal(strategy('btc-momentum-retest').version, '2.1.0');
  assert.equal(strategy('btc-momentum-retest').leverageCap, 18);
  assert.equal(strategy('btc-compression-breakout').version, '1.1.0');
  assert.equal(strategy('btc-compression-breakout').leverageCap, 20);
  assert.equal(strategy('btc-orderflow-absorption').version, '0.3.0-shadow');
  assert.equal(strategy('btc-orderflow-absorption').leverageCap, 15);
  assert.equal(strategy('btc-cvd-divergence').version, '0.2.0-shadow');
  assert.equal(strategy('btc-cvd-divergence').leverageCap, 12);
});
