import { acquireWorkerLeadership, registerPrimaryClaim, clearPrimaryClaim, startYieldWatch, isPrimaryInstance, startLeaderAddressPublication } from './leadership';
import { startStandbyServer, StandbyServer } from './standby';

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
}

async function boot() {
  let standby: StandbyServer | null = null;
  let attempt = 0;

  while (!(await acquireWorkerLeadership())) {
    attempt++;
    await registerPrimaryClaim();   // a waiting primary signals the current leader to yield
    if (!standby) standby = await startStandbyServer();
    const delay = Math.min(15_000, 2_000 + attempt * 1_000) + Math.floor(Math.random() * 1_000);
    console.log(`[boot] standby follower; retrying worker leadership in ${delay}ms`);
    await sleep(delay);
  }

  if (standby) {
    console.log('[boot] leadership available; promoting standby into active scanner');
    await standby.close();
  }
  if (isPrimaryInstance()) await clearPrimaryClaim();   // stop signaling once we lead
  startYieldWatch();                                    // non-primary leaders yield to a waiting primary
  startLeaderAddressPublication();                      // standby proxies the public domain to this address
  await startLeaderWorker();
}

boot().catch(error => {
  console.error('[boot]', error);
  process.exit(1);
});
