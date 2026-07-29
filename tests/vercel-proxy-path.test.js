'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const handler = require('../api/[...path].js');

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
