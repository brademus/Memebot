import test from 'node:test';
import assert from 'node:assert/strict';
import { hasIndependentOpportunityConfirmation, isSecondWaveRetrace } from './bestbuys';
import { TokenRecord } from '../types';

function token(overrides: Partial<TokenRecord> = {}): TokenRecord {
  return {
    socials: { tg: false, x: false, web: false, fetched: true, tgMembers: null },
    bundle: null,
    smartHits: [],
    ...overrides,
  } as TokenRecord;
}

test('accepts only the configured 25-40 percent second-wave retrace', () => {
  assert.equal(isSecondWaveRetrace(75, 100, 0.25, 0.40), true);
  assert.equal(isSecondWaveRetrace(60, 100, 0.25, 0.40), true);
  assert.equal(isSecondWaveRetrace(76, 100, 0.25, 0.40), false);
  assert.equal(isSecondWaveRetrace(59, 100, 0.25, 0.40), false);
});

test('rejects missing or invalid peak data', () => {
  assert.equal(isSecondWaveRetrace(0, 100, 0.25, 0.40), false);
  assert.equal(isSecondWaveRetrace(75, 0, 0.25, 0.40), false);
});

test('opportunities require at least one independent confirmation', () => {
  assert.equal(hasIndependentOpportunityConfirmation(token()), false);
  assert.equal(hasIndependentOpportunityConfirmation(token({
    socials: { tg: false, x: true, web: false, fetched: true, tgMembers: null },
  })), true);
  assert.equal(hasIndependentOpportunityConfirmation(token({
    bundle: { insiderPct: 4, fundedSnipers: 0, slot0Buyers: 0, clusterPct: 6 },
  })), true);
});

test('funded or concentrated bundles do not qualify as confirmation', () => {
  assert.equal(hasIndependentOpportunityConfirmation(token({
    bundle: { insiderPct: 4, fundedSnipers: 1, slot0Buyers: 0, clusterPct: 6 },
  })), false);
  assert.equal(hasIndependentOpportunityConfirmation(token({
    bundle: { insiderPct: 30, fundedSnipers: 0, slot0Buyers: 0, clusterPct: 30 },
  })), false);
});
