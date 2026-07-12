import { currentBestBuys } from './bestbuys';

const INTERVAL_MS = 5_000;
let started = false;
let running = false;

/**
 * Best Buys admissions used to run only when a browser requested /api/bestbuys.
 * That made alert timing depend on whether the dashboard happened to be open.
 * Run the engine continuously in the worker and keep the HTTP route read-compatible.
 */
export function startBestBuysEngine() {
  if (started) return;
  started = true;

  const evaluate = () => {
    if (running) return;
    running = true;
    try {
      currentBestBuys();
    } catch (e) {
      console.error('[bestbuys] evaluation failed:', (e as Error).message);
    } finally {
      running = false;
    }
  };

  evaluate();
  setInterval(evaluate, INTERVAL_MS);
  console.log(`[bestbuys] server-side engine running every ${INTERVAL_MS / 1000}s`);
}
