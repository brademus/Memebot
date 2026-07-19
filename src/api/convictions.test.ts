import test from 'node:test';
import assert from 'node:assert/strict';
import { currentBestBuys } from './convictions';
import { isConvictionCandidate } from '../scoring/conviction-queue';
import { addToken, removeToken } from '../store';

test('reading the convictions API cannot admit a qualified watchlist token', () => {
  const ca = `read-only-conviction-${Date.now()}`;
  const token = addToken({
    ca,
    symbol: 'READ',
    name: 'Read only lifecycle test',
    creator: null,
    source: 'pumpfun',
  });
  assert.ok(token);

  Object.assign(token, {
    firstSeen: Date.now() - 10 * 60_000,
    gated: true,
    state: 'HEATING',
    score: 95,
    peakScore: 95,
    priceUsd: 1,
    firstScorePrice: 1,
    liquidityUsd: 25_000,
    mcapUsd: 80_000,
    dex: 'pumpfun',
    curveSol: 50,
    peakCurveSol: 50,
    totalBuys: 50,
    totalSells: 5,
    buys5m: 20,
    sells5m: 2,
    uniqueBuyers: Array.from({ length: 20 }, (_, index) => `buyer-${index}`),
    devBuyPct: 1,
    bundle: { insiderPct: 3, fundedSnipers: 0, slot0Buyers: 0, clusterPct: 4 },
    socials: { x: true, tg: false, web: false, fetched: true, tgMembers: null },
  });

  assert.equal(isConvictionCandidate(ca), false);
  assert.equal(currentBestBuys().some(item => item.ca === ca), false);
  assert.equal(isConvictionCandidate(ca), false);
  removeToken(ca);
});
