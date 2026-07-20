import test from 'node:test';
import assert from 'node:assert/strict';
import { ReportJobManager } from './report-jobs';

async function waitForTerminal(manager: ReportJobManager, id: string) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const status = manager.get(id);
    if (status && (status.status === 'ready' || status.status === 'error')) return status;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('report job did not finish');
}

test('report jobs return immediately, finish asynchronously, and reconstruct exact JSON from chunks', async () => {
  const payload = {
    reportType: 'daily_master_review',
    text: 'trade-evidence-🚀'.repeat(4_000),
    trades: Array.from({ length: 25 }, (_, index) => ({ index, reason: `reason-${index}` })),
  };
  const manager = new ReportJobManager(async days => ({ ...payload, days }), {
    chunkCharacters: 10_000,
    readyTtlMs: 60_000,
    runningTtlMs: 60_000,
  });

  const started = manager.start(1);
  assert.equal(started.status, 'queued');
  const duplicate = manager.start(1);
  assert.equal(duplicate.id, started.id);
  assert.equal(duplicate.reused, true);

  const ready = await waitForTerminal(manager, started.id);
  assert.equal(ready.status, 'ready');
  assert.ok(ready.totalChunks > 1);
  assert.ok(ready.resultBytes > 0);

  const chunks: string[] = [];
  for (let index = 0; index < ready.totalChunks; index++) {
    const result = manager.getChunk(started.id, index);
    assert.ok(result);
    assert.equal(result.index, index);
    chunks.push(result.chunk);
  }
  assert.deepEqual(JSON.parse(chunks.join('')), { ...payload, days: 1 });
  assert.equal(manager.getChunk(started.id, ready.totalChunks), null);
});

test('report jobs surface builder failures without hanging', async () => {
  const manager = new ReportJobManager(async () => {
    throw new Error('database unavailable');
  });
  const started = manager.start(1);
  const finished = await waitForTerminal(manager, started.id);
  assert.equal(finished.status, 'error');
  assert.equal(finished.error, 'database unavailable');
  assert.equal(manager.getChunk(started.id, 0), null);
});
