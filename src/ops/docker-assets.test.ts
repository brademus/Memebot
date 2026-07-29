import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('Railway runtime image includes the BTC migration schema', () => {
  const dockerfile = fs.readFileSync('Dockerfile', 'utf8');
  const lines = dockerfile.split(/\r?\n/).filter(line => /^COPY\s/.test(line));
  const runtimeSchemaCopies = lines.filter(line => line.includes('schema-btc.sql'));
  assert.ok(runtimeSchemaCopies.length >= 2, 'schema-btc.sql must be copied into both builder and runtime stages');
});
