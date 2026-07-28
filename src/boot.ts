import {
  acquireWorkerLeadership,
  registerPrimaryClaim,
  clearPrimaryClaim,
  startYieldWatch,
  startLeaderAddressPublication,
} from './leadership';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function startLeaderWorker() {
  const { startBestBuysEngine } = await import('./api/bestbuys-runner');
  startBestBuysEngine();
  await import('./index');

  // Refresh the latest persisted quality-selection reference before any candidate can
  // complete its minimum conviction hold. The final trigger remains fail-closed until
  // price, liquidity, buyer retention, and market continuity are revalidated.
  const { startEntryRevalidation } = await import('./scoring/entry-revalidation');
  startEntryRevalidation();

  const { startForwardEvidenceCollector } = await import('./tuning/snapshots');
  startForwardEvidenceCollector();

  const { startModelRuntime } = await import('./model/runtime');
  startModelRuntime();

  const { startPaperEvidenceHealthMonitor } = await import('./paper/persistence-health');
  startPaperEvidenceHealthMonitor();

  // Start a fresh prospective evidence epoch before evaluating the revised exit policy.
  // This prevents pre-change outcomes from being mixed into the new policy's headline.
  const { startStrategyPolicyEpoch } = await import('./paper/strategy-policy-epoch');
  startStrategyPolicyEpoch();

  // Quality selection is now a research observation, not a paper purchase. Only the
  // later trigger opens a timed $100 paper position, and every wait/hold/sell decision
  // is persisted with its evidence for strategy refinement.
  const { startStrategyLifecycle } = await import('./paper/strategy-lifecycle');
  startStrategyLifecycle();
  const { startStrategyLedgerReconciler } = await import('./paper/strategy-ledger-reconciler');
  startStrategyLedgerReconciler();
  const { startStrategyExtremaReconciler } = await import('./paper/strategy-extrema-reconciler');
  startStrategyExtremaReconciler();

  const { startDatabaseMaintenance } = await import('./ops/db-maintenance');
  startDatabaseMaintenance();

  const { startPaperSnapshotRetention } = await import('./ops/paper-snapshot-retention');
  startPaperSnapshotRetention();

  const { startReadOnlyDiagnosticsPublisher } = await import('./ops/read-only-diagnostics-publisher');
  startReadOnlyDiagnosticsPublisher();

  // Initialize and start Jupiter unsigned simulation canary (safe, no signing/broadcasting)
  const { initializeJupiterCanary, startJupiterCanary } = await import('./paper/jupiter-canary');
  await initializeJupiterCanary();
  startJupiterCanary();
}

async function boot() {
  let attempt = 0;

  while (!(await acquireWorkerLeadership())) {
    attempt++;
    await registerPrimaryClaim();
    const delay = Math.min(10_000, 1_000 + attempt * 750) + Math.floor(Math.random() * 500);
    console.log(`[boot] waiting for active scanner takeover; retrying in ${delay}ms`);
    await sleep(delay);
  }

  await clearPrimaryClaim();
  startYieldWatch();
  startLeaderAddressPublication();

  console.log('[boot] leadership confirmed; starting scanner worker');
  await startLeaderWorker();
  console.log('[boot] scanner worker started and dashboard is active');
}

boot().catch(error => {
  console.error('[boot]', error);
  process.exit(1);
});
