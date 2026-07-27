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

  const { startForwardEvidenceCollector } = await import('./tuning/snapshots');
  startForwardEvidenceCollector();

  const { startModelRuntime } = await import('./model/runtime');
  startModelRuntime();

  const { startPaperEvidenceHealthMonitor } = await import('./paper/persistence-health');
  startPaperEvidenceHealthMonitor();

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