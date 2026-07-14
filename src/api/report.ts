import { buildReport as buildForwardReport } from './report-v2';
import { buildSignalReport } from './signal-report';

export async function buildReport(days = 7) {
  const [base, signalStack] = await Promise.all([
    buildForwardReport(days),
    buildSignalReport(days),
  ]);
  return { ...base, signalStack };
}
