import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluatePairedVariant,
  policyFingerprintFor,
  rankExperimentCandidates,
  runnerStopMultiple,
  stableStringify,
  summarizePairedOutcomes,
} from './system-v3';

test('policy fingerprints are deterministic across object key order and change on policy changes', () => {
  const left = { strategy: { target: 3, stop: 0.5 }, weights: { organic: 30, velocity: 20 } };
  const reordered = { weights: { velocity: 20, organic: 30 }, strategy: { stop: 0.5, target: 3 } };
  const changed = { weights: { velocity: 21, organic: 29 }, strategy: { stop: 0.5, target: 3 } };
  assert.equal(stableStringify(left), stableStringify(reordered));
  assert.equal(policyFingerprintFor(left), policyFingerprintFor(reordered));
  assert.notEqual(policyFingerprintFor(left), policyFingerprintFor(changed));
});

test('paired policies relax exactly one condition and preserve all other gates', () => {
  const base = {
    evidenceReady: true,
    persistenceReady: true,
    burstCooled: true,
    tooLate: false,
    sourceEligible: true,
    modelAllows: true,
    state: 'HEATING',
  };
  assert.equal(evaluatePairedVariant('control_current', base), true);
  assert.equal(evaluatePairedVariant('control_current', { ...base, tooLate: true }), false);
  assert.equal(evaluatePairedVariant('late_ceiling_plus_25pct', { ...base, tooLate: true }), true);
  assert.equal(evaluatePairedVariant('late_ceiling_plus_25pct', { ...base, tooLate: true, persistenceReady: false }), false);
  assert.equal(evaluatePairedVariant('persistence_one_check_relaxed', { ...base, persistenceReady: false }), true);
  assert.equal(evaluatePairedVariant('burst_cooldown_relaxed', { ...base, burstCooled: false }), true);
  assert.equal(evaluatePairedVariant('burst_cooldown_relaxed', { ...base, state: 'DEAD', burstCooled: false }), false);
});

test('runner stop never falls below the verified 3x exit and trails higher peaks', () => {
  assert.equal(runnerStopMultiple(3, 0.25), 3);
  assert.equal(runnerStopMultiple(4, 0.25), 3);
  assert.equal(runnerStopMultiple(8, 0.25), 6);
  assert.equal(runnerStopMultiple(Number.NaN, 0.25), 3);
});

test('experiment ranking requires sample depth and penalizes severe-loss admissions', () => {
  const ranked = rankExperimentCandidates([
    { sourceLayer: 'entry', reasonCode: 'too_late', total: 40, missed3x: 8, severeLosses: 2 },
    { sourceLayer: 'gate', reasonCode: 'low_liquidity', total: 40, missed3x: 10, severeLosses: 12 },
    { sourceLayer: 'entry', reasonCode: 'tiny_sample', total: 8, missed3x: 5, severeLosses: 0 },
  ]);
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].reasonCode, 'too_late');
  assert.ok(ranked[0].score > ranked[1].score);
});

test('paired summaries compare only opportunities resolved by both policies', () => {
  const control = [
    { quality_trade_id: '1', policy_id: 'control_current', exit_multiple: 3, target_hit: true, severe_loss: false },
    { quality_trade_id: '2', policy_id: 'control_current', exit_multiple: 0.5, target_hit: false, severe_loss: true },
  ];
  const variant = [
    { quality_trade_id: '1', policy_id: 'late_ceiling_plus_25pct', exit_multiple: 4, target_hit: true, severe_loss: false },
    { quality_trade_id: '3', policy_id: 'late_ceiling_plus_25pct', exit_multiple: 3, target_hit: true, severe_loss: false },
  ];
  const summary = summarizePairedOutcomes(control, variant);
  assert.equal(summary.pairedResolved, 1);
  assert.equal(summary.controlTargetRate, 1);
  assert.equal(summary.variantTargetRate, 1);
  assert.equal(summary.controlMedianMultiple, 3);
  assert.equal(summary.variantMedianMultiple, 4);
});
