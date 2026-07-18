import test from 'node:test';
import assert from 'node:assert/strict';
import { qualifiesActivityWallet } from './winnerminer';

const activity = { trades: 28, buys: 17, tokens: 8 };

test('promotes heavily active Pump.fun wallets with proven realized profit', () => {
  assert.equal(qualifiesActivityWallet({
    roundTrips: 9,
    realizedPnlSol: 1.4,
    realizedRoi: 0.22,
    verdict: 'ELITE',
  }, activity), true);
});

test('rejects active wallets that are not actually profitable', () => {
  assert.equal(qualifiesActivityWallet({
    roundTrips: 12,
    realizedPnlSol: -0.4,
    realizedRoi: -0.08,
    verdict: 'REJECT',
  }, activity), false);
});

test('rejects profitable wallets without enough Pump.fun activity', () => {
  assert.equal(qualifiesActivityWallet({
    roundTrips: 8,
    realizedPnlSol: 0.8,
    realizedRoi: 0.16,
    verdict: 'GOOD',
  }, { trades: 12, buys: 8, tokens: 4 }), false);
});

test('rejects one-off lucky wallets without enough measured exits', () => {
  assert.equal(qualifiesActivityWallet({
    roundTrips: 2,
    realizedPnlSol: 3,
    realizedRoi: 1.2,
    verdict: 'ELITE',
  }, activity), false);
});
