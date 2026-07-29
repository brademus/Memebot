import { getBtcStatus, startBtcPaperEngine } from './runtime';

let publishing = false;

async function publishStatus(): Promise<void> {
  if (publishing || !process.send) return;
  publishing = true;
  try {
    process.send({ type: 'btc-status', payload: await getBtcStatus() });
  } catch (error) {
    console.error('[btc-worker] status publish failed:', (error as Error).message);
  } finally {
    publishing = false;
  }
}

async function main(): Promise<void> {
  await startBtcPaperEngine();
  await publishStatus();
  setInterval(() => void publishStatus(), 5_000);
  console.log('[btc-worker] isolated paper engine active');
}

main().catch(error => {
  const normalized = error instanceof Error ? error : new Error(String(error));
  console.error('[btc-worker] fatal startup:', normalized);
  if (!process.send) {
    process.exit(1);
    return;
  }
  process.send({
    type: 'btc-fatal',
    error: normalized.message,
    stack: normalized.stack?.slice(0, 4_000) || null,
    at: Date.now(),
  }, () => setTimeout(() => process.exit(1), 25));
});
