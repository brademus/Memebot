import assert from 'node:assert/strict';
import test from 'node:test';
import { compactId, describeVariable, redactDiagnosticError } from './read-only-diagnostics';

test('describeVariable reports presence without exposing the value', () => {
  const source = { HELIUS_API_KEY: '  secret-value-123  ' } as NodeJS.ProcessEnv;
  const summary = describeVariable('HELIUS_API_KEY', true, source);
  assert.equal(summary.present, true);
  assert.equal(summary.required, true);
  assert.equal(summary.hadSurroundingWhitespace, true);
  assert.equal(summary.hasOuterQuotes, false);
  assert.equal(summary.fingerprint?.length, 10);
  assert.equal(JSON.stringify(summary).includes('secret-value-123'), false);
});

test('simulation wallet validation exposes validity, not the address', () => {
  const wallet = '11111111111111111111111111111111';
  const summary = describeVariable('SIMULATION_WALLET', true, { SIMULATION_WALLET: wallet } as NodeJS.ProcessEnv);
  assert.equal(summary.validPublicWallet, true);
  assert.equal(JSON.stringify(summary).includes(wallet), false);
});

test('diagnostic errors redact connection URLs and query secrets', () => {
  const redacted = redactDiagnosticError('failed postgresql://user:pass@host/db?api-key=topsecret');
  assert.equal(redacted.includes('user:pass'), false);
  assert.equal(redacted.includes('topsecret'), false);
  assert.match(redacted, /REDACTED/);
});

test('deployment IDs are compacted', () => {
  assert.equal(compactId('1234567890abcdefghijkl'), '12345678…ijkl');
  assert.equal(compactId(undefined), null);
});
