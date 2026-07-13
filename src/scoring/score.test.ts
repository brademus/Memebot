import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreRawVector } from './score';

const raw = {
  freshness: 0.2,
  velocity: 0.8,
  buy_pressure: 0.4,
  organic: 0.7,
  social: 0.3,
  smart_money: 0.6,
};
const weights = {
  freshness: 10,
  velocity: 25,
  buy_pressure: 15,
  organic: 20,
  social: 15,
  smart_money: 15,
};

test('scores all six calibrated components independently', () => {
  const expected = 0.2 * 10 + 0.8 * 25 + 0.4 * 15 + 0.7 * 20 + 0.3 * 15 + 0.6 * 15;
  assert.equal(scoreRawVector(raw, weights, {}), expected);
});

test('applies learned direction to social as well as other features', () => {
  const normal = scoreRawVector(raw, weights, {});
  const inverted = scoreRawVector(raw, weights, { social: -1 });
  assert.equal(inverted - normal, (1 - raw.social - raw.social) * weights.social);
});
