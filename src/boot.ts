import { acquireWorkerLeadership } from './leadership';
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
}

async function boot() {
  let standby: StandbyServer | null = null;
  let attempt = 0;

  while (!(await acquireWorkerLeadership())) {
    attempt++;
    if (!standby) standby = await startStandbyServer();
    const delay = Math.min(15_000, 2_000 + attempt * 1_000) + Math.floor(Math.random() * 1_000);
    console.log(`[boot] standby follower; retrying worker leadership in ${delay}ms`);
    await sleep(delay);
  }

  if (standby) {
    console.log('[boot] leadership available; promoting standby into active scanner');
    await standby.close();
  }
  await startLeaderWorker();
}

boot().catch(error => {
  console.error('[boot]', error);
  process.exit(1);
});
