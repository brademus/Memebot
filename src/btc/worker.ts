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
  console.error('[btc-worker] fatal startup:', error);
  process.exit(1);
});
