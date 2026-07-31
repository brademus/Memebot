'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const handler = require('../api/[...path].js');
const btcReportJob = require('../api/btc-review-job.js');
const btcReportChunk = require('../api/btc-review-chunk.js');

test('uses Vercel catch-all query segments when present', () => {
  assert.equal(handler.requestPath({ query: { path: ['calls'] }, url: '/api/calls' }), 'calls');
  assert.equal(handler.requestPath({ query: { path: ['wallet-rankings', 'recent'] }, url: '/api/wallet-rankings/recent' }), 'wallet-rankings/recent');
});

test('falls back to the actual request URL when query path is absent', () => {
  assert.equal(handler.requestPath({ query: {}, url: '/api/calls' }), 'calls');
  assert.equal(handler.requestPath({ query: {}, url: '/api/stream?cursor=abc' }), 'stream');
  assert.equal(handler.requestPath({ query: { days: '7' }, url: '/api/report?days=7' }), 'report');
});

test('normalizes encoded route segments and API root', () => {
  assert.equal(handler.requestPath({ query: {}, url: '/api/wallet%20debug' }), 'wallet%20debug');
  assert.equal(handler.requestPath({ query: {}, url: '/api/' }), '');
});

function responseCapture() {
  return {
    statusCode: 0,
    headers: {},
    body: Buffer.alloc(0),
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = String(value); },
    json(value) { this.body = Buffer.from(JSON.stringify(value)); return this; },
    end(value) { this.body = Buffer.isBuffer(value) ? value : Buffer.from(value || ''); },
  };
}

test('flat BTC report endpoints proxy nested Railway job and chunk paths', async () => {
  const previousBackend = process.env.MEMEBOT_BACKEND_URL;
  const previousFetch = global.fetch;
  process.env.MEMEBOT_BACKEND_URL = 'https://railway.example/base';
  const targets = [];
  global.fetch = async target => {
    targets.push(String(target));
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    const jobResponse = responseCapture();
    await btcReportJob({ method: 'GET', query: { id: 'job-123' } }, jobResponse);
    assert.equal(jobResponse.statusCode, 200);
    assert.equal(targets[0], 'https://railway.example/base/api/btc-review-jobs/job-123');

    const chunkResponse = responseCapture();
    await btcReportChunk({ method: 'GET', query: { id: 'job-123', index: '4' } }, chunkResponse);
    assert.equal(chunkResponse.statusCode, 200);
    assert.equal(targets[1], 'https://railway.example/base/api/btc-review-jobs/job-123/chunks/4');
  } finally {
    global.fetch = previousFetch;
    if (previousBackend === undefined) delete process.env.MEMEBOT_BACKEND_URL;
    else process.env.MEMEBOT_BACKEND_URL = previousBackend;
  }
});

test('Vercel preserves cached nested BTC report URLs and disables stale report JavaScript caching', () => {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8'));
  assert.deepEqual(config.rewrites, [
    {
      source: '/api/btc-review-jobs/:id/chunks/:index',
      destination: '/api/btc-review-chunk?id=:id&index=:index',
    },
    {
      source: '/api/btc-review-jobs/:id',
      destination: '/api/btc-review-job?id=:id',
    },
  ]);
  const reportScriptHeaders = config.headers.find(item => item.source === '/btc-review.js');
  assert.ok(reportScriptHeaders, 'BTC report script cache policy is missing');
  assert.ok(reportScriptHeaders.headers.some(item => (
    item.key === 'Cache-Control' && item.value.includes('no-store')
  )));
});

test('BTC report UI restarts a PostgreSQL-backed export after an in-memory worker job is lost', () => {
  const script = fs.readFileSync(path.join(__dirname, '..', 'public', 'btc-review.js'), 'utf8');
  assert.match(script, /MAX_WORKER_RESTARTS = 3/);
  assert.match(script, /error\.status = response\.status/);
  assert.match(script, /Number\(error\.status\) !== 404/);
  assert.match(script, /No trade data was lost; the report is rebuilt from PostgreSQL/);
});
