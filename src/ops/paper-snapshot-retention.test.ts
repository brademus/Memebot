import assert from 'node:assert';
import { test } from 'node:test';
import { paperSnapshotRetentionDiag, PAPER_SNAPSHOT_RETENTION_BATCH_SQL } from './paper-snapshot-retention';

test('Paper snapshot retention diagnostics', async () => {
  const diag = paperSnapshotRetentionDiag();

  assert(typeof diag.enabled === 'boolean', 'enabled should be boolean');
  assert(typeof diag.running === 'boolean', 'running should be boolean');
  assert(typeof diag.runs === 'number', 'runs should be number');
  assert(diag.runs >= 0, 'runs should be non-negative');
  assert(typeof diag.rawRetentionDays === 'number', 'rawRetentionDays should be number');
  assert(typeof diag.aggregateRetentionDays === 'number', 'aggregateRetentionDays should be number');
  assert(typeof diag.batchSize === 'number', 'batchSize should be number');
  assert(typeof diag.lastRunRowsProcessed === 'number', 'lastRunRowsProcessed should be number');
  assert(typeof diag.lastRunRowsDeleted === 'number', 'lastRunRowsDeleted should be number');
});

test('Paper snapshot retention SQL shape validation', async () => {
  const diag = paperSnapshotRetentionDiag();

  // Verify configuration is reasonable
  assert(diag.rawRetentionDays > 0, 'raw retention must be positive');
  assert(diag.aggregateRetentionDays > diag.rawRetentionDays, 'aggregate retention must exceed raw retention');
  assert(diag.batchSize > 0, 'batch size must be positive');
  assert(diag.batchSize < 50000, 'batch size should be reasonable');
});

test('Retention batch SQL structure', () => {
  // Verify the exported SQL constant contains the expected CTE components
  assert(PAPER_SNAPSHOT_RETENTION_BATCH_SQL.includes('batch_ids'), 'SQL must define batch_ids CTE');
  assert(PAPER_SNAPSHOT_RETENTION_BATCH_SQL.includes('agg_result'), 'SQL must define agg_result CTE');
  assert(PAPER_SNAPSHOT_RETENTION_BATCH_SQL.includes('del_result'), 'SQL must define del_result CTE');
  assert(PAPER_SNAPSHOT_RETENTION_BATCH_SQL.includes('LIMIT $2'), 'SQL must have bounded LIMIT $2');
  assert(PAPER_SNAPSHOT_RETENTION_BATCH_SQL.includes('DELETE FROM paper_trade_snapshots'), 'SQL must DELETE from paper_trade_snapshots');
  assert(PAPER_SNAPSHOT_RETENTION_BATCH_SQL.includes('WHERE id IN (SELECT id FROM batch_ids)'), 'DELETE must select bounded batch_ids');

  // Assert no unsafe patterns
  const deleteWithLimit = /DELETE[\s\S]{0,200}LIMIT/i;
  assert(!deleteWithLimit.test(PAPER_SNAPSHOT_RETENTION_BATCH_SQL), 'SQL must not have DELETE...LIMIT pattern (unbounded)');
  assert(!PAPER_SNAPSHOT_RETENTION_BATCH_SQL.includes('DROP'), 'SQL must not contain DROP');
});

