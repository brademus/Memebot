import test from 'node:test';
import assert from 'node:assert/strict';
import { pumpPortalGuardDiag } from './pumpportal-guard';

test('PumpPortal guard persists a conservative daily and rolling two-week budget', () => {
  const diag = pumpPortalGuardDiag();
  assert.ok(diag.maxActiveTokens <= 10);
  assert.equal(diag.budgetMode, 'postgres_daily_and_rolling_14d');
  assert.equal(diag.maxPaidEventsPerBoot, null);
  assert.ok(diag.persistentBudget.dailyEventLimit <= 4_000);
  assert.ok(diag.persistentBudget.rolling14dEventLimit <= 50_000);
  assert.ok(diag.persistentBudget.maxDailyCostSol <= 0.004);
  assert.ok(diag.persistentBudget.maxRolling14dCostSol <= 0.05);
  assert.equal(diag.persistentBudget.failClosedWithoutDatabase, true);
  assert.equal(diag.paidEventsThisBoot, 0);
  assert.equal(diag.budgetTripped, false);
});
