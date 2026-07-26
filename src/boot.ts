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

  // Retain the exact 60-minute v2 comparison table while v3 adds richer 15/60/240
  // minute state observations, competing risks, regime labels and execution evidence.
  const { startForwardEvidenceCollector } = await import('./tuning/snapshots');
  startForwardEvidenceCollector();

  const { startModelRuntime } = await import('./model/runtime');
  startModelRuntime();

  // Persistence must be proven in production, not inferred from successful builds.
  // This alarm compares mature model decisions with their expected paper evidence rows.
  const { startPaperEvidenceHealthMonitor } = await import('./paper/persistence-health');
  startPaperEvidenceHealthMonitor();

  // Publish an allowlisted, aggregate-only diagnostics snapshot through the existing
  // static dashboard server. No raw rows, secret values, or write controls are exposed.
  const { startReadOnlyDiagnosticsPublisher } = await import('./ops/read-only-diagnostics-publisher');
  startReadOnlyDiagnosticsPublisher();
}

async function boot() {
  let attempt = 0;

  // Do not expose a dashboard-only standby. Railway keeps the previous healthy deploy
  // serving traffic while this replacement waits. The replacement asks the old worker
  // to release its database lease, and only opens the public port after the scanner is
  // genuinely ready to start. This prevents a green/live UI with zero scans or calls.
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
