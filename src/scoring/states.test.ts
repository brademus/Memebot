import test from 'node:test';
import assert from 'node:assert/strict';
import { updateState } from './states';
import { TokenRecord } from '../types';

function token(overrides: Partial<TokenRecord> = {}): TokenRecord {
  return {
    firstSeen: Date.now() - 5 * 60_000,
    state: 'WATCHING',
    stateChangedAt: Date.now() - 2 * 60_000,
    score: 70,
    peakScore: 70,
    firstScorePrice: 1,
    priceUsd: 1,
    buys5m: 12,
    sells5m: 3,
    totalBuys: 20,
    totalSells: 3,
    uniqueBuyers: Array.from({ length: 15 }, (_, i) => `wallet-${i}`),
    triggeredAt: null,
    insiderKilled: false,
    dex: 'raydium',
    peakCurveSol: 0,
    curveSol: 0,
    ...overrides,
  } as TokenRecord;
}

test('promotes a persistent evidence-backed token to trigger', () => {
  const candidate = token();
  assert.equal(updateState(candidate), 'TRIGGER');
});

test('classifies an uncalled 40 percent runner as extended before promotion', () => {
  const candidate = token({ priceUsd: 1.5 });
  assert.equal(updateState(candidate), 'EXTENDED');
});

test('does not eject an already-triggered winner for becoming extended', () => {
  const candidate = token({ state: 'TRIGGER', triggeredAt: Date.now() - 60_000, priceUsd: 1.5 });
  assert.equal(updateState(candidate), null);
  assert.equal(candidate.state, 'TRIGGER');
});

test('death conditions take precedence over trigger promotion', () => {
  const candidate = token({ insiderKilled: true });
  assert.equal(updateState(candidate), 'DYING');
});
