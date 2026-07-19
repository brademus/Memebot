import test from 'node:test';
import assert from 'node:assert/strict';
import { rankToken } from './rank';
import { TokenRecord } from '../types';

function token(score: number): TokenRecord {
  return {
    score,
    state: 'HEATING',
    firstScorePrice: 1,
    priceUsd: 1.05,
    dex: 'pumpfun',
    curveSol: 35,
    socials: { tg: false, x: true, web: false, fetched: true, tgMembers: null },
    bundle: null,
    smartHits: [],
    totalBuys: 12,
    totalSells: 3,
    buys5m: 8,
    sells5m: 2,
    uniqueBuyers: Array.from({ length: 8 }, (_, index) => `wallet-${index}`),
    earlyBuyers: [],
    earlyExited: [],
    peakCurveSol: 35,
    devBuyPct: 2,
    liquidityUsd: 15_000,
    mcapUsd: 60_000,
    firstSeen: Date.now() - 2 * 60_000,
  } as unknown as TokenRecord;
}

test('score 50 is B-grade and can reach the configured conviction floor', () => {
  assert.equal(rankToken(token(50)).grade, 'B');
});

test('scores below the conviction floor remain C-grade or lower', () => {
  assert.equal(rankToken(token(49)).grade, 'C');
});
