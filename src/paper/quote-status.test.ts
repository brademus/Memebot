import test from 'node:test';
import assert from 'node:assert/strict';
import { quoteCategory, quotePhase } from './quote-status';

test('separates legacy, pre-key and post-key quote attempts', () => {
  assert.equal(quotePhase('legacy_mark', null), 'legacy');
  assert.equal(quotePhase('jupiter_api_key_missing', false), 'pre_key');
  assert.equal(quotePhase('jupiter_no_route', true), 'post_key');
});

test('classifies build, simulation and routing outcomes', () => {
  assert.equal(quoteCategory('jupiter_http_401'), 'unauthorized');
  assert.equal(quoteCategory('jupiter_http_429'), 'rate_limited');
  assert.equal(quoteCategory('jupiter_no_route'), 'no_route');
  assert.equal(quoteCategory('transaction_not_built'), 'transaction_not_built');
  assert.equal(quoteCategory('simulation_failed:{"InstructionError":1}'), 'simulation_failed');
  assert.equal(quoteCategory('route_unstable'), 'route_unstable');
  assert.equal(quoteCategory('price_impact_too_high'), 'price_impact');
  assert.equal(quoteCategory('jupiter_timeout'), 'timeout');
  assert.equal(quoteCategory('executable_simulated'), 'simulated_executable');
});
