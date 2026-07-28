import assert from 'node:assert/strict';
import test from 'node:test';
import { TokenRecord } from '../types';
import {
  assessEntryRevalidation,
  QualityReference,
} from './entry-revalidation';

function token(overrides: Partial<TokenRecord> = {}): TokenRecord {
  return {
    ca: 'test-ca',
    source: 'pumpfun',
    dex: 'pumpswap',
    priceUsd: 1.2,
    liquidityUsd: 20_000,
    mcapUsd: 100_000,
    curveSol: 0,
    firstScorePrice: 1.1,
    earlyBuyers: Array.from({ length: 10 }, (_, index) => `buyer-${index}`),
    earlyExited: ['buyer-0', 'buyer-1'],
    ...overrides,
  } as unknown as TokenRecord;
}

function reference(overrides: Partial<QualityReference> = {}): QualityReference {
  return {
    paperTradeId: 42,
    ca: 'test-ca',
    signal: 'bb_organic',
    selectedAt: 1_000_000,
    selectedPrice: 1,
    ...overrides,
  };
}

test('healthy entry remains eligible after final quality revalidation', () => {
  const result = assessEntryRevalidation(token(), 1_120_000, reference());
  assert.equal(result.revalidationReady, true);
  assert.equal(result.qualityTooLate, false);
  assert.equal(result.liquidityReady, true);
  assert.equal(result.retentionReady, true);
  assert.equal(result.marketContinuityReady, true);
  assert.deepEqual(result.revalidationBlockers, []);
});

test('rejects a JFB-like chase with tiny liquidity, exited buyers, and broken price continuity', () => {
  const earlyBuyers = Array.from({ length: 19 }, (_, index) => `buyer-${index}`);
  const result = assessEntryRevalidation(token({
    priceUsd: 2.2601,
    liquidityUsd: 11.71,
    firstScorePrice: 54.84,
    earlyBuyers,
    earlyExited: earlyBuyers.slice(0, 16),
  }), 1_665_000, reference({ selectedPrice: 1 }));

  assert.equal(result.revalidationReady, false);
  assert.equal(result.qualityTooLate, true);
  assert.equal(result.liquidityReady, false);
  assert.equal(result.retentionReady, false);
  assert.equal(result.marketContinuityReady, false);
  assert.ok(result.revalidationBlockers.some(reason => reason.includes('above the quality-selection price')));
  assert.ok(result.revalidationBlockers.some(reason => reason.includes('liquidity $11.71')));
  assert.ok(result.revalidationBlockers.some(reason => reason.includes('early-buyer retention')));
  assert.ok(result.revalidationBlockers.some(reason => reason.includes('price is down')));
});

test('fails closed when no persisted quality-selection reference is available', () => {
  const result = assessEntryRevalidation(token(), 1_120_000, null);
  assert.equal(result.revalidationReady, false);
  assert.ok(result.revalidationBlockers.includes('quality selection reference unavailable or stale'));
});

test('aged entries retain their stricter USD liquidity floor', () => {
  const result = assessEntryRevalidation(token({
    source: 'aged',
    liquidityUsd: 40_000,
    mcapUsd: 1_000_000,
  }), 1_120_000, reference());
  assert.equal(result.revalidationReady, false);
  assert.equal(result.liquidityReady, false);
  assert.ok(result.revalidationBlockers.some(reason => reason.includes('below $50000')));
});

test('aged entries retain their liquidity-to-market-cap floor', () => {
  const result = assessEntryRevalidation(token({
    source: 'aged',
    liquidityUsd: 60_000,
    mcapUsd: 3_000_000,
  }), 1_120_000, reference());
  assert.equal(result.revalidationReady, false);
  assert.equal(result.liquidityReady, false);
  assert.ok(result.revalidationBlockers.some(reason => reason.includes('liquidity/mcap 2.00%')));
});

test('healthy aged liquidity passes both final checks', () => {
  const result = assessEntryRevalidation(token({
    source: 'aged',
    liquidityUsd: 60_000,
    mcapUsd: 1_000_000,
  }), 1_120_000, reference());
  assert.equal(result.revalidationReady, true);
  assert.equal(result.liquidityReady, true);
});
