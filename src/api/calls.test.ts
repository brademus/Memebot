import test from 'node:test';
import assert from 'node:assert/strict';
import { BUY_ALERT_SIGNAL, normalizeDashboardCall, PaperCallRow } from './calls';

function row(overrides: Partial<PaperCallRow> = {}): PaperCallRow {
  return {
    ca: 'TokenAddress111111111111111111111111111111',
    symbol: 'TEST',
    signal: 'trigger',
    entry_at: '2026-07-18T12:00:00.000Z',
    entry_score: 72,
    entry_price: 2,
    peak_price: 3,
    last_price: 2,
    last_at: '2026-07-18T12:10:00.000Z',
    exit_price: null,
    exit_at: null,
    exit_reason: null,
    closed: false,
    execution_eligible: true,
    quote_status: 'eligible',
    target_hit_at: null,
    observed_target_hit_at: null,
    position_usd: 25,
    ...overrides,
  };
}

test('only the actual buy-alert signal is eligible for Current Calls', () => {
  assert.equal(BUY_ALERT_SIGNAL, 'trigger');
  assert.notEqual(BUY_ALERT_SIGNAL, 'conviction');
});

test('open calls show live hypothetical PnL from the alert entry', () => {
  const call = normalizeDashboardCall(row({ last_price: 3 }));
  assert.equal(call.status, 'open');
  assert.equal(call.multiple, 1.5);
  assert.equal(call.pnlPct, 50);
  assert.equal(call.normalizedPnlUsd, 50);
  assert.equal(call.simulatedPnlUsd, 12.5);
});

test('closed profitable calls are winners', () => {
  const call = normalizeDashboardCall(row({
    closed: true,
    exit_price: 5,
    exit_at: '2026-07-18T13:00:00.000Z',
    exit_reason: 'target_3x_exit_simulated',
  }));
  assert.equal(call.status, 'win');
  assert.equal(call.pnlPct, 150);
  assert.equal(call.normalizedPnlUsd, 150);
});

test('closed negative calls are losses', () => {
  const call = normalizeDashboardCall(row({
    closed: true,
    exit_price: 1,
    exit_at: '2026-07-18T13:00:00.000Z',
    exit_reason: 'stop_50pct',
  }));
  assert.equal(call.status, 'loss');
  assert.equal(call.pnlPct, -50);
  assert.equal(call.normalizedPnlUsd, -50);
});

test('tracking gaps are unresolved rather than forced into wins or losses', () => {
  const call = normalizeDashboardCall(row({
    closed: true,
    exit_price: null,
    last_price: 2.6,
    exit_at: '2026-07-18T13:00:00.000Z',
    exit_reason: 'tracking_lost',
  }));
  assert.equal(call.status, 'unresolved');
  assert.equal(call.pnlPct, 30);
});
