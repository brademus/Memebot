import test from 'node:test';
import assert from 'node:assert/strict';
import { refreshTradeWindow } from './trade-window';
import { TokenRecord, TradeEvent } from '../types';

const now = 1_000_000;

function trade(at: number, buy: boolean): TradeEvent {
  return {
    at,
    buy,
    wallet: null,
    solAmount: null,
    tokenAmount: null,
    signature: null,
    slot: null,
    priceUsd: null,
    curveSol: null,
  };
}

function token(overrides: Partial<TokenRecord> = {}) {
  return {
    dex: 'pumpfun',
    buys5m: 12,
    sells5m: 3,
    recentTrades: [],
    ...overrides,
  } as TokenRecord;
}

test('lite mode preserves Dexscreener aggregate buys and sells', () => {
  const candidate = token({
    recentTrades: [trade(now - 10 * 60_000, true)],
  });

  refreshTradeWindow(candidate, now, 'lite');

  assert.equal(candidate.recentTrades.length, 0);
  assert.equal(candidate.buys5m, 12);
  assert.equal(candidate.sells5m, 3);
});

test('full mode rebuilds the PumpPortal five-minute window from exact events', () => {
  const candidate = token({
    recentTrades: [
      trade(now - 10 * 60_000, true),
      trade(now - 60_000, true),
      trade(now - 30_000, false),
    ],
  });

  refreshTradeWindow(candidate, now, 'full');

  assert.equal(candidate.recentTrades.length, 2);
  assert.equal(candidate.buys5m, 1);
  assert.equal(candidate.sells5m, 1);
});

test('non-Pump.fun tokens keep their aggregate window in either mode', () => {
  const candidate = token({ dex: 'raydium', buys5m: 8, sells5m: 2 });

  refreshTradeWindow(candidate, now, 'full');

  assert.equal(candidate.buys5m, 8);
  assert.equal(candidate.sells5m, 2);
});
