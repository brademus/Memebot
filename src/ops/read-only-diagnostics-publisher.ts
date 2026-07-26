import fs from 'node:fs/promises';
import path from 'node:path';
import { buildReadOnlyDiagnostics, redactDiagnosticError } from './read-only-diagnostics';

const OUTPUT_PATH = path.join(process.cwd(), 'public', 'read-only-diagnostics.json');
const TEMP_PATH = `${OUTPUT_PATH}.tmp`;
const REFRESH_MS = 5 * 60_000;

let writing = false;
let lastPublishedAt: string | null = null;
let lastError: string | null = null;

export const readOnlyDiagnosticsPublisherDiag = () => ({
  output: '/read-only-diagnostics.json',
  refreshSeconds: Math.round(REFRESH_MS / 1000),
  writing,
  lastPublishedAt,
  lastError,
});

async function publish() {
  if (writing) return;
  writing = true;
  try {
    const report: any = await buildReadOnlyDiagnostics();
    report.publisher = {
      output: '/read-only-diagnostics.json',
      refreshSeconds: Math.round(REFRESH_MS / 1000),
      previousPublishedAt: lastPublishedAt,
    };
    await fs.writeFile(TEMP_PATH, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(TEMP_PATH, OUTPUT_PATH);
    lastPublishedAt = new Date().toISOString();
    lastError = null;
    console.log(`[diagnostics] sanitized read-only snapshot published at ${OUTPUT_PATH}`);
  } catch (error) {
    lastError = redactDiagnosticError((error as Error).message);
    console.error(`[diagnostics] publish failed: ${lastError}`);
    await fs.rm(TEMP_PATH, { force: true }).catch(() => {});
  } finally {
    writing = false;
  }
}

export function startReadOnlyDiagnosticsPublisher() {
  void publish();
  const timer = setInterval(() => void publish(), REFRESH_MS);
  timer.unref();
}
