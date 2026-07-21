import test from 'node:test';
import assert from 'node:assert/strict';
import { pumpPortalGuardDiag } from './pumpportal-guard';

test('PumpPortal private-mode guard cannot exceed the minimum-balance budget', () => {
  const diag = pumpPortalGuardDiag();
  assert.ok(diag.maxActiveTokens <= 10);
  assert.ok(diag.maxPaidEventsPerBoot <= 3000);
  assert.ok(diag.maxEstimatedCostPerBootSol <= 0.003);
  assert.equal(diag.paidEventsThisBoot, 0);
  assert.equal(diag.budgetTripped, false);
});
