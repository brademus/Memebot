import { startServer } from './api/server';
import { acquireWorkerLeadership } from './leadership';

async function boot() {
  const isLeader = await acquireWorkerLeadership();
  if (!isLeader) {
    // A duplicate Railway deployment remains healthy and can serve the durable
    // dashboard, but it must not scan, register webhooks, learn, trade, or alert.
    startServer();
    console.log('[memewatch] follower dashboard running; worker loops disabled');
    return;
  }

  const { startBestBuysEngine } = await import('./api/bestbuys-runner');
  startBestBuysEngine();

  // index.ts owns the leader worker lifecycle and starts immediately when imported.
  await import('./index');

  // Starts after the worker import and waits before its first tick, allowing initDb
  // to finish. It captures 3/5/10/15-minute score snapshots and resolves each from
  // its own exact 60-minute-forward price instead of discovery-price outcomes.
  const { startForwardEvidenceCollector } = await import('./tuning/snapshots');
  startForwardEvidenceCollector();
}

boot().catch(error => {
  console.error('[boot]', error);
  process.exit(1);
});
