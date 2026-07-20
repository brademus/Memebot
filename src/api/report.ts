import { buildHistoricalReview } from './historical-review';
import { buildMasterReview } from './master-review';
import { buildReport as buildForwardReport } from './report-v2';
import { buildSignalReport } from './signal-report';

interface SectionResult {
  value: Record<string, any>;
  durationMs: number;
  timedOut: boolean;
}

async function runSection(
  name: string,
  work: () => Promise<any>,
  timeoutMs = 18_000,
): Promise<SectionResult> {
  const started = Date.now();
  let timer: NodeJS.Timeout | null = null;
  try {
    const value = await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${name} exceeded ${timeoutMs}ms`)), timeoutMs);
        timer.unref();
      }),
    ]);
    return { value: value as Record<string, any>, durationMs: Date.now() - started, timedOut: false };
  } catch (error) {
    const message = (error as Error).message;
    return {
      value: { error: `${name} failed: ${message}` },
      durationMs: Date.now() - started,
      timedOut: message.includes('exceeded'),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function buildReport(days = 1) {
  // The complete review remains one copyable object, but no optional section may hold
  // the HTTP request open indefinitely. Each section degrades to an explicit error field.
  const [base, signalStack, master, historical] = await Promise.all([
    runSection('base calibration report', () => buildForwardReport(days)),
    runSection('Signal Stack report', () => buildSignalReport(days)),
    runSection('daily trade review', () => buildMasterReview(days)),
    runSection('historical trade review', () => buildHistoricalReview()),
  ]);

  const masterRecord = master.value;
  const historicalRecord = historical.value;
  const overall = masterRecord.overall ? {
    ...masterRecord.overall,
    profitabilityReadiness: historicalRecord.profitabilityReadinessBySetup
      || masterRecord.overall.profitabilityReadiness,
  } : undefined;

  return {
    ...base.value,
    signalStack: signalStack.value,
    ...masterRecord,
    ...historicalRecord,
    ...(overall ? { overall } : {}),
    reportBuild: {
      timeoutMsPerSection: 18_000,
      sections: {
        base: { durationMs: base.durationMs, timedOut: base.timedOut },
        signalStack: { durationMs: signalStack.durationMs, timedOut: signalStack.timedOut },
        daily: { durationMs: master.durationMs, timedOut: master.timedOut },
        historical: { durationMs: historical.durationMs, timedOut: historical.timedOut },
      },
    },
  };
}
