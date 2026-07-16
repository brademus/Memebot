import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHeliusTrade } from './helius-trade-backfill';
import { TokenRecord } from '../types';

test('Helius reconstruction classifies wallet token inflow as a buy', () => {
  const token = { ca: 'mint', priceUsd: 0.00001, curveSol: 35 } as TokenRecord;
  const event = parseHeliusTrade({
    signature: 'sig', timestamp: 1_700_000_000, slot: 123, feePayer: 'buyer',
    tokenTransfers: [{ mint: 'mint', fromUserAccount: 'curve', toUserAccount: 'buyer', tokenAmount: 1_000 }],
    nativeTransfers: [{ fromUserAccount: 'buyer', toUserAccount: 'curve', amount: 100_000_000 }],
  }, token);
  assert.ok(event);
  assert.equal(event.buy, true);
  assert.equal(event.wallet, 'buyer');
  assert.equal(event.solAmount, 0.1);
  assert.equal(event.tokenAmount, 1_000);
});

test('Helius reconstruction classifies wallet token outflow as a sell', () => {
  const token = { ca: 'mint', priceUsd: 0.00001, curveSol: 40 } as TokenRecord;
  const event = parseHeliusTrade({
    signature: 'sig2', timestamp: 1_700_000_100, slot: 124, feePayer: 'seller',
    tokenTransfers: [{ mint: 'mint', fromUserAccount: 'seller', toUserAccount: 'curve', tokenAmount: 500 }],
    nativeTransfers: [{ fromUserAccount: 'curve', toUserAccount: 'seller', amount: 75_000_000 }],
  }, token);
  assert.ok(event);
  assert.equal(event.buy, false);
  assert.equal(event.wallet, 'seller');
  assert.equal(event.solAmount, 0.075);
});
