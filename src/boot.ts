import path from 'path';
import { ChildProcess, fork } from 'child_process';
import {
  acquireWorkerLeadership,
  registerPrimaryClaim,
  clearPrimaryClaim,
  startYieldWatch,
  startLeaderAddressPublication,
} from './leadership';
import { BtcWorkerStatusMessage, markBtcWorkerUnavailable, setBtcWorkerStatus } from './btc/bridge';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let btcChild: ChildProcess | null = null;
let btcRestartTimer: NodeJS.Timeout | null = null;
let stopping = false;

function startIsolatedBtcWorker(): void {
  if (stopping || btcChild) return;
  const workerPath = path.join(__dirname, 'btc', 'worker.js');
  const child = fork(workerPath, [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  btcChild = child;

  child.on('message', message => {
    const candidate = message as Partial<BtcWorkerStatusMessage>;
    if (candidate?.type === 'btc-status' && candidate.payload && typeof candidate.payload === 'object') {
      setBtcWorkerStatus(candidate.payload);
    }
  });
  child.on('error', error => {
    markBtcWorkerUnavailable(`BTC worker process error: ${error.message}`);
  });
  child.on('exit', (code, signal) => {
    btcChild = null;
    const reason = `BTC worker exited (${signal || code || 'unknown'}); supervised restart scheduled`;
    console.error(`[btc] ${reason}`);
    markBtcWorkerUnavailable(reason);
    if (!stopping && !btcRestartTimer) {
      btcRestartTimer = setTimeout(() => {
        btcRestartTimer = null;
        startIsolatedBtcWorker();
      }, 30_000);
      btcRestartTimer.unref();
    }
  });
  console.log(`[btc] supervised child worker started pid=${child.pid || 'pending'}`);
}

function stopIsolatedBtcWorker(): void {
  stopping = true;
  if (btcRestartTimer) clearTimeout(btcRestartTimer);
  btcRestartTimer = null;
  btcChild?.kill('SIGTERM');
}

process.once('SIGTERM', stopIsolatedBtcWorker);
process.once('SIGINT', stopIsolatedBtcWorker);

async function startLeaderWorker() {
  // index starts the async core database migration and scanner bootstrap.
  await import('./index');

  // Evidence System v3 fingerprints every strategy-relevant configuration, journals
  // execution mutations append-only, evaluates paired shadow policies on the same
  // opportunities, gives every exit its own continuation shadow, and runs execution-
  // quoted runner experiments. It is measurement-only and never signs or broadcasts.
  const { initializeEvidenceSystemV3, startEvidenceSystemV3 } = await import('./evidence/system-v3');
  const { waitForCorePaperSchema, hardenEvidenceSystemV3Schema } = await import('./evidence/schema-hardening');
  await waitForCorePaperSchema();
  await initializeEvidenceSystemV3();
  await hardenEvidenceSystemV3Schema();
  startEvidenceSystemV3();

  const { startBestBuysEngine } = await import('./api/bestbuys-runner');
  startBestBuysEngine();

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

  // Coinbase/Kraken parsing runs in a supervised child process. An exchange-protocol
  // exception can restart only BTC and can never terminate the existing Memebot API.
  startIsolatedBtcWorker();
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
