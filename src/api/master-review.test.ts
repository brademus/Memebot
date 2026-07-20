import assert from 'node:assert/strict';
import test from 'node:test';
import { compactHistoricalTrade, configSnapshotId } from './historical-review';
import { reviewMarketBucket } from './master-review';

test('daily review market path uses bounded decision-relevant buckets', () => {
  assert.equal(reviewMarketBucket(0), 0);
  assert.equal(reviewMarketBucket(59), 0);
  assert.equal(reviewMarketBucket(60), 1);
  assert.equal(reviewMarketBucket(10 * 60), 100);
  assert.equal(reviewMarketBucket(60 * 60), 200);
  assert.equal(reviewMarketBucket(4 * 60 * 60), 300);
  assert.equal(reviewMarketBucket(5 * 60 * 60), 301);
});

test('historical ledger keeps trade rationale without duplicating raw telemetry blobs', () => {
  const config = { weights: { velocity: 17.3 }, nested: { enabled: true } };
  const hugeRaw = 'x'.repeat(100_000);
  const row = {
    id: 7,
    ca: 'contract',
    symbol: 'TEST',
    signal: 'bb_organic',
    model_version: 'v3',
    token_source: 'aged',
    play_type: 'RUNNER',
    entry_at: new Date(0).toISOString(),
    entry_price: 1,
    entry_score: 72,
    closed: true,
    exit_at: new Date(60_000).toISOString(),
    exit_price: 2,
    exit_reason: 'target_hit',
    final_multiple: 2,
    pnl_pct: 100,
    config_snapshot: config,
    conviction_snapshot: { lane: 'organic', label: 'sustained flow' },
    trigger_snapshot: { reason: 'entry timing clear' },
    rank_snapshot: { grade: 'A', timing: 'EARLY' },
    signal_decision: { allow: true, preliminaryPass: true, reasons: ['good route'] },
    has_entry_context: true,
    has_exit_context: true,
    execution_eligible: true,
    transaction_built: true,
    simulation_ok: true,
    snapshot_count: 50,
    event_count: 4,
    raw: hugeRaw,
  };
  const id = configSnapshotId(config);
  const compact = compactHistoricalTrade(row, id);
  const serialized = JSON.stringify(compact);

  assert.equal(compact.setup, 'post_grad_continuation');
  assert.equal(compact.entry.configSnapshotId, id);
  assert.ok(compact.entry.recordedReasons.includes('Conviction evidence: sustained flow'));
  assert.ok(compact.entry.recordedReasons.includes('Trigger reason: entry timing clear'));
  assert.equal(serialized.includes(hugeRaw), false);
  assert.equal(serialized.includes('config_snapshot'), false);
  assert.equal(serialized.includes('rawDatabaseRecord'), false);
});
