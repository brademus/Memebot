import test from 'node:test';
import assert from 'node:assert/strict';
import { pumpPortalGuardDiag } from './pumpportal-guard';
import { PUMPPORTAL_DAILY_PAID_EVENT_LIMIT } from './pumpportal-persistent-budget';

test('PumpPortal guard owns subscriptions and preserves the persistent spending ceiling', () => {
  const diag = pumpPortalGuardDiag();
  assert.ok(diag.maxActiveTokens >= 1 && diag.maxActiveTokens <= 100);
  assert.ok(diag.maxPendingTokens <= 250);
  assert.ok(diag.quietSlotLeaseSeconds >= 30);
  assert.ok(diag.rotationIntervalSeconds >= 10);
  assert.ok(diag.providerRetrySeconds >= 60);
  assert.equal(diag.subscriptionStrategy, 'single_owner_fresh_priority_no_scanner_unsubscribe');
  assert.equal(diag.budgetMode, 'postgres_daily_and_rolling_14d_with_time_aware_pacing');
  assert.equal(diag.pacingStrategy, 'proportional_to_day_remaining');
  // Assert the WIRING and the CLAMP, not a frozen target: the daily limit must be
  // exactly the exported budget constant, and that constant must sit under the
  // hard ceiling (30,000/day ~= $1.6/day at 0.01 SOL per 10k msgs) that makes
  // runaway spend impossible. The target itself is a user dial ($10/week as of
  // 2026-07-28), not an invariant.
  assert.equal(diag.persistentBudget.dailyEventLimit, PUMPPORTAL_DAILY_PAID_EVENT_LIMIT);
  assert.ok(PUMPPORTAL_DAILY_PAID_EVENT_LIMIT > 0 && PUMPPORTAL_DAILY_PAID_EVENT_LIMIT <= 30_000);
  assert.ok(diag.persistentBudget.rolling14dEventLimit <= 50_000);
  assert.ok(diag.persistentBudget.maxDailyCostSol <= 0.004);
  assert.ok(diag.persistentBudget.maxRolling14dCostSol <= 0.05);
  assert.equal(diag.persistentBudget.failClosedWithoutDatabase, true);
  assert.equal(diag.persistentBudget.reservationModel, 'expiring_process_lease');
  assert.equal(diag.persistentBudget.legacyReservationLeakProtected, true);
  assert.ok(diag.persistentBudget.reservationLeaseSeconds >= 120);
  assert.equal(diag.paidEventsThisBoot, 0);
  assert.equal(diag.budgetTripped, false);
  assert.equal(diag.providerRejected, false);
  assert.equal(diag.ignoredApplicationUnsubscribes, 0);
  assert.ok(Array.isArray(diag.activeTokenKeys));
  assert.ok(Number.isFinite(diag.persistentBudget.targetDailyPaceEventsPerSecond));
});
