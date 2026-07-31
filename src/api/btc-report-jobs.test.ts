import assert from 'node:assert/strict';
import test from 'node:test';
import { BtcReportJobManager } from './btc-report-jobs';

async function waitForTerminal(manager: BtcReportJobManager, id: string) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const job = manager.get(id);
    if (job && (job.status === 'ready' || job.status === 'error')) return job;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('BTC report job did not finish');
}

test('BTC report jobs build a named ZIP asynchronously and expose exact byte chunks', async () => {
  const manager = new BtcReportJobManager(async days => ({
    reportType: 'btc_strategy_trade_review',
    days,
    trades: Array.from({ length: 200 }, (_, index) => ({ id: `trade-${index}`, resultR: index / 10 })),
  }), {
    archiveChunkBytes: 32 * 1024,
    readyTtlMs: 60_000,
    runningTtlMs: 60_000,
  });

  const started = manager.start(3650);
  assert.equal(started.status, 'queued');
  const duplicate = manager.start(3650);
  assert.equal(duplicate.id, started.id);
  assert.equal(duplicate.reused, true);

  const ready = await waitForTerminal(manager, started.id);
  assert.equal(ready.status, 'ready');
  assert.match(String(ready.downloadFilename), /^memebot-btc-trade-review-all-time-\d{4}-\d{2}-\d{2}\.zip$/);
  assert.ok(ready.archiveBytes > 0);
  assert.ok(ready.resultBytes > 0);
  assert.ok(ready.totalChunks >= 1);

  const parts: Buffer[] = [];
  for (let index = 0; index < ready.totalChunks; index++) {
    const chunk = manager.getChunk(started.id, index);
    assert.ok(chunk);
    assert.equal(chunk.index, index);
    assert.equal(chunk.totalChunks, ready.totalChunks);
    assert.equal(chunk.encoding, 'base64');
    parts.push(Buffer.from(chunk.chunk, 'base64'));
  }
  const archive = Buffer.concat(parts);
  assert.equal(archive.length, ready.archiveBytes);
  assert.equal(archive.subarray(0, 2).toString('ascii'), 'PK');
  assert.equal(manager.getChunk(started.id, ready.totalChunks), null);
});

test('BTC report jobs surface builder failures without hanging', async () => {
  const manager = new BtcReportJobManager(async () => {
    throw new Error('BTC ledger unavailable');
  });
  const started = manager.start();
  const finished = await waitForTerminal(manager, started.id);
  assert.equal(finished.status, 'error');
  assert.equal(finished.error, 'BTC ledger unavailable');
  assert.equal(manager.getChunk(started.id, 0), null);
});
