import test from 'node:test';
import assert from 'node:assert/strict';
import { checkConviction, convictionFiredToday } from './conviction';
import { ConvictionQueueStatus } from './conviction-queue';
import { TokenRecord } from '../types';

const now = Date.now();

function token(overrides: Partial<TokenRecord> = {}): TokenRecord {
  return {
    ca: 'conviction-test', symbol: 'TEST', name: 'Test', creator: null, source: 'pumpfun',
    firstSeen: now - 5 * 60_000, priceUsd: 1, liquidityUsd: 20_000, mcapUsd: 80_000,
    vol5m: 10_000, buys5m: 24, sells5m: 6, priceChange5m: 8, pairAddress: null, dex: 'raydium',
    curveSol: 0, curveSamples: [], uniqueBuyers: Array.from({ length: 20 }, (_, index) => `w${index}`),
    devBuyPct: 2, totalBuys: 24, totalSells: 6, recentTrades: [],
    earlyBuyers: Array.from({ length: 8 }, (_, index) => `e${index}`), earlyExited: ['e0'], peakCurveSol: 0,
    socials: { x: true, tg: false, web: false, fetched: true, tgMembers: null },
    triggeredAt: null, triggerPrice: null, insiderKilled: false, convictionAt: now - 180_000,
    gated: true, gateFailReason: null, score: 70, peakScore: 72, firstScorePrice: 1,
    state: 'HEATING', stateChangedAt: now - 180_000, modelDecision: null, modelDecisionAt: null,
    ...overrides,
  } as TokenRecord;
}

function queued(overrides: Partial<ConvictionQueueStatus> = {}): ConvictionQueueStatus {
  return {
    queued: true, lane: 'organic', enteredAt: now - 180_000, heldSeconds: 180,
    minimumHoldSeconds: 120, holdReady: true, scoreFloor: 60, ...overrides,
  };
}

test('conviction is a pre-alert queue state, not a second alert after buying', () => {
  const result = checkConviction(token({ convictionAt: null }), now);
  assert.equal(result.pass, false);
  assert.equal(result.missing.includes('not selected for conviction'), true);
  assert.equal(convictionFiredToday(), 0);
});

test('a queued conviction passes only when entry timing is ready', () => {
  const result = checkConviction(token(), now, queued());
  assert.equal(result.pass, true, result.missing.join('; '));
  assert.equal(result.confirmed.some(reason => reason.includes('conviction held')), true);
});

test('a queued conviction remains pending while the observation hold is incomplete', () => {
  const result = checkConviction(token(), now, queued({ heldSeconds: 30, holdReady: false }));
  assert.equal(result.pass, false);
  assert.equal(result.missing.some(reason => reason.includes('remaining')), true);
});
