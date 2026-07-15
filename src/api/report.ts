import { buildReport as buildForwardReport } from './report-v2';
import { buildSignalReport } from './signal-report';

export async function buildReport(days = 7) {
  // Isolate the two halves: a failure in the signal-stack report must degrade to
  // an error FIELD, not destroy the entire weekly report. (A single malformed SQL
  // query in signal-report took down /api/report completely — Promise.all rejects
  // on the first error, so the healthy base report died with it.)
  const [base, signalStack] = await Promise.all([
    buildForwardReport(days),
    buildSignalReport(days).catch((e: Error) => ({ error: `signal report failed: ${e.message}` })),
  ]);
  return { ...base, signalStack };
}
