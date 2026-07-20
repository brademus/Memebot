import { buildHistoricalReview } from './historical-review';
import { buildMasterReview } from './master-review';
import { buildReport as buildForwardReport } from './report-v2';
import { buildSignalReport } from './signal-report';

export async function buildReport(days = 1) {
  // One copyable review contains the daily aggregate/calibration report, Signal Stack
  // evidence, cumulative profitability evidence, every historical trade, runtime health,
  // and full snapshot-by-snapshot detail for calls relevant to the daily window.
  // Each component degrades to an error field instead of taking down the entire report.
  const [base, signalStack, master, historical] = await Promise.all([
    buildForwardReport(days).catch((error: Error) => ({ error: `base report failed: ${error.message}` })),
    buildSignalReport(days).catch((error: Error) => ({ error: `signal report failed: ${error.message}` })),
    buildMasterReview(days).catch((error: Error) => ({ error: `master review failed: ${error.message}` })),
    buildHistoricalReview().catch((error: Error) => ({ error: `historical review failed: ${error.message}` })),
  ]);
  return { ...base, signalStack, ...master, ...historical };
}
