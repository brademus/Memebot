import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { ReportJobManager } from './report-jobs';
import { crc32 } from './single-file-zip';

async function waitForTerminal(manager: ReportJobManager, id: string) {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    const status = manager.get(id);
    if (status && (status.status === 'ready' || status.status === 'error')) return status;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('report job did not finish');
}

function extractSingleZipFile(archive: Buffer) {
  assert.equal(archive.readUInt32LE(0), 0x04034b50, 'local ZIP header signature');
  assert.equal(archive.readUInt16LE(8), 8, 'ZIP entry must use deflate');
  const expectedCrc = archive.readUInt32LE(14);
  const compressedSize = archive.readUInt32LE(18);
  const uncompressedSize = archive.readUInt32LE(22);
  const nameLength = archive.readUInt16LE(26);
  const extraLength = archive.readUInt16LE(28);
  const filename = archive.subarray(30, 30 + nameLength).toString('utf8');
  const compressedStart = 30 + nameLength + extraLength;
  const content = inflateRawSync(archive.subarray(compressedStart, compressedStart + compressedSize));
  assert.equal(content.length, uncompressedSize);
  assert.equal(crc32(content), expectedCrc);
  return { filename, content };
}

test('report jobs return immediately and reconstruct an exact downloadable ZIP from chunks', async () => {
  const payload = {
    reportType: 'daily_master_review',
    text: 'trade-evidence-🚀',
    incompressibleEvidence: randomBytes(220_000).toString('base64'),
    trades: Array.from({ length: 25 }, (_, index) => ({ index, reason: `reason-${index}` })),
  };
  const manager = new ReportJobManager(async days => ({ ...payload, days }), {
    archiveChunkBytes: 32 * 1024,
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
  assert.ok(ready.archiveBytes > 0);
  assert.match(ready.downloadFilename || '', /^memebot-daily-master-review-\d{4}-\d{2}-\d{2}\.zip$/);

  const chunks: Buffer[] = [];
  for (let index = 0; index < ready.totalChunks; index++) {
    const result = manager.getChunk(started.id, index);
    assert.ok(result);
    assert.equal(result.index, index);
    assert.equal(result.encoding, 'base64');
    assert.equal(result.filename, ready.downloadFilename);
    chunks.push(Buffer.from(result.chunk, 'base64'));
  }
  const archive = Buffer.concat(chunks);
  assert.equal(archive.length, ready.archiveBytes);
  const extracted = extractSingleZipFile(archive);
  assert.equal(extracted.filename, 'daily-master-review.json');
  assert.deepEqual(JSON.parse(extracted.content.toString('utf8')), { ...payload, days: 1 });
  assert.equal(manager.getChunk(started.id, ready.totalChunks), null);
});

test('CRC32 matches the standard check value', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
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
