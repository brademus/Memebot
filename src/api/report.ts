import { buildCleanEvidence } from './clean-evidence';
import { buildHistoricalReview } from './historical-review';
import { buildMasterReview } from './master-review';
import { buildReport as buildForwardReport } from './report-v2';
import { buildSignalReport } from './signal-report';
import { buildStrategyIntegrityReport } from './strategy-integrity-report';
import { buildStrategyLifecycleReport } from './strategy-lifecycle-report';

interface SectionResult {
  value: Record<string, any>;
  durationMs: number;
  timedOut: boolean;
}

export async function runSection(
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

export async function buildReport(days = 1, options: { sectionTimeoutMs?: number } = {}) {
  // The complete review remains one copyable object, but no optional section may hold
  // the HTTP request open indefinitely. Each section degrades to an explicit error field.
  //
  // TIMEOUT IS PER-CALLER (2026-07-31): the 18s default protects the synchronous
  // /api/daily-review route, which genuinely holds an HTTP request open. The
  // background job path (the dashboard button that produces the exported ZIPs)
  // has no such constraint — and on 07-31 the base and daily sections crossed
  // 18s for the first time from plain data growth (~19k paid events and their
  // downstream rows added the prior day), silently dropping runtimeHealth, the
  // 3x autopsy, and the honest windows from the export MID-FREEZE, when the
  // report is the entire point. Jobs now pass a patient ceiling; the section
  // still degrades to an explicit error rather than hanging forever.
  const sectionTimeoutMs = Math.max(5_000, options.sectionTimeoutMs || 18_000);
  const [base, signalStack, master, historical, cleanEvidence, strategyLifecycle, strategyIntegrity] = await Promise.all([
    runSection('base calibration report', () => buildForwardReport(days), sectionTimeoutMs),
    runSection('Signal Stack report', () => buildSignalReport(days), sectionTimeoutMs),
    runSection('daily trade review', () => buildMasterReview(days), sectionTimeoutMs),
    runSection('historical trade review', () => buildHistoricalReview(), sectionTimeoutMs),
    runSection('clean post-repair evidence', () => buildCleanEvidence(days), sectionTimeoutMs),
    runSection('quality-entry-exit strategy lifecycle', () => buildStrategyLifecycleReport(days), sectionTimeoutMs),
    runSection('strategy integrity and execution honesty', () => buildStrategyIntegrityReport(days), sectionTimeoutMs),
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
    cleanEvidence: cleanEvidence.value,
    strategyLifecycle: strategyLifecycle.value,
    strategyIntegrity: strategyIntegrity.value,
    ...masterRecord,
    ...historicalRecord,
    ...(overall ? { overall } : {}),
    reportBuild: {
      timeoutMsPerSection: sectionTimeoutMs,
      sections: {
        base: { durationMs: base.durationMs, timedOut: base.timedOut },
        signalStack: { durationMs: signalStack.durationMs, timedOut: signalStack.timedOut },
        daily: { durationMs: master.durationMs, timedOut: master.timedOut },
        historical: { durationMs: historical.durationMs, timedOut: historical.timedOut },
        cleanEvidence: { durationMs: cleanEvidence.durationMs, timedOut: cleanEvidence.timedOut },
        strategyLifecycle: { durationMs: strategyLifecycle.durationMs, timedOut: strategyLifecycle.timedOut },
        strategyIntegrity: { durationMs: strategyIntegrity.durationMs, timedOut: strategyIntegrity.timedOut },
      },
    },
  };
}
