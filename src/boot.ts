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
}

boot().catch(error => {
  console.error('[boot]', error);
  process.exit(1);
});
