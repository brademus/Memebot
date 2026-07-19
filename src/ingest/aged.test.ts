import assert from 'node:assert/strict';
import test from 'node:test';
import { cfg } from '../config';
import { addToken, removeToken } from '../store';
import { agedPersistenceReady } from '../scoring/persistence';
import { assessAgedPool } from './aged';

function healthyAttributes(now: number) {
  return {
    pool_created_at: new Date(now - 7 * 24 * 3_600_000).toISOString(),
    reserve_in_usd: '100000',
    market_cap_usd: '1000000',
    fdv_usd: '1000000',
    volume_usd: { h24: '300000', h1: '20000', m5: '1800' },
    transactions: {
      h1: { buys: 40, sells: 20 },
      m5: { buys: 12, sells: 7 },
    },
    price_change_percentage: { m5: '4', h1: '12', h24: '30' },
    base_token_price_usd: '0.001',
  };
}

test('aged scanner admits an established liquid revival with sustained activity', () => {
  const now = Date.now();
  const result = assessAgedPool(healthyAttributes(now), now);
  assert.equal(result.eligible, true);
  assert.equal(result.reason, null);
  assert.ok(result.metrics.ageHours > cfg().aged.min_age_hours);
  assert.ok(result.metrics.buyRatio1h >= cfg().aged.min_buy_ratio_1h);
});

test('aged scanner rejects young pools and vertical five-minute chases', () => {
  const now = Date.now();
  const young = healthyAttributes(now);
  young.pool_created_at = new Date(now - 12 * 3_600_000).toISOString();
  assert.equal(assessAgedPool(young, now).reason, 'too_young');

  const vertical = healthyAttributes(now);
  vertical.price_change_percentage.m5 = String(cfg().aged.max_change5m_pct + 1);
  assert.equal(assessAgedPool(vertical, now).reason, 'five_minute_chase');
});

test('aged persistence requires repeated flow with stable price and liquidity', () => {
  const now = Date.now();
  const ca = `aged-test-${now}`;
  const token = addToken({ ca, symbol: 'AGED', name: 'Aged test', creator: null, source: 'aged' });
  assert.ok(token);
  token!.firstSeen = now - 4 * 60_000;
  token!.marketCreatedAt = now - 7 * 24 * 3_600_000;
  token!.dex = 'raydium';
  token!.priceUsd = 1.04;
  token!.liquidityUsd = 102000;
  token!.buys5m = 13;
  token!.sells5m = 8;
  token!.priceChange5m = 4;
  token!.marketSamples = Array.from({ length: cfg().aged.confirmation_samples }, (_, index) => ({
    at: now - 180_000 + index * (180_000 / Math.max(1, cfg().aged.confirmation_samples - 1)),
    priceUsd: 1 + index * 0.008,
    liquidityUsd: 100000 + index * 400,
    vol5m: 2000 + index * 100,
    buys5m: 12 + index,
    sells5m: 8,
  }));
  assert.equal(agedPersistenceReady(token!, now), true);

  token!.marketSamples[token!.marketSamples.length - 1].liquidityUsd = 75000;
  assert.equal(agedPersistenceReady(token!, now), false);
  removeToken(ca);
});
