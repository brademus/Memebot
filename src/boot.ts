import { startServer } from './api/server';
import { acquireWorkerLeadership } from './leadership';

async function boot() {
  const isLeader = await acquireWorkerLeadership();
  if (!isLeader) {
    startServer();
    console.log('[memewatch] follower dashboard running; worker loops disabled');
    return;
  }

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

boot().catch(error => {
  console.error('[boot]', error);
  process.exit(1);
});
