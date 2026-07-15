import { pool } from '../db';
import { MODEL_VERSION } from '../model/version';

export type PaperPersistenceStage =
  | 'decision_lookup'
  | 'insert'
  | 'raw_status_update'
  | 'token_missing_update'
  | 'entry_quote_update'
  | 'open_trade_read'
  | 'mark_update'
  | 'exit_quote_update'
  | 'target_update'
  | 'close_update'
  | 'scoreboard_read'
  | 'quote_status_read'
  | 'diagnostic_read'
  | 'health_read';

interface PersistenceRuntime {
  insertAttempts: number;
  inserted: number;
  duplicates: number;
  failures: Record<string, number>;
  lastInsertAt: string | null;
  lastFailureAt: string | null;
  lastError: string | null;
  lastStage: string | null;
}

const runtime: PersistenceRuntime = {
  insertAttempts: 0,
  inserted: 0,
  duplicates: 0,
  failures: {},
  lastInsertAt: null,
  lastFailureAt: null,
  lastError: null,
  lastStage: null,
};

export function recordPaperInsertAttempt() {
  runtime.insertAttempts++;
}

export function recordPaperInsertResult(inserted: boolean) {
  if (inserted) {
    runtime.inserted++;
    runtime.lastInsertAt = new Date().toISOString();
    runtime.lastError = null;
  } else {
    runtime.duplicates++;
  }
}

export function recordPaperFailure(stage: PaperPersistenceStage, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  runtime.failures[stage] = (runtime.failures[stage] || 0) + 1;
  runtime.lastFailureAt = new Date().toISOString();
  runtime.lastError = message;
  runtime.lastStage = stage;
  console.error(`[paper:${stage}]`, message);
}

export function paperPersistenceRuntimeDiag() {
  return {
    ...runtime,
    failures: { ...runtime.failures },
    totalFailures: Object.values(runtime.failures).reduce((sum, count) => sum + count, 0),
  };
}

export interface EvidenceHealthCounts {
  preliminaryTokens: number;
  allowedTokens: number;
  rawRows: number;
  executableRows: number;
  rawMissingTokens: number;
  executableMissingTokens: number;
}

export function assessEvidenceHealth(counts: EvidenceHealthCounts) {
  const idle = counts.preliminaryTokens === 0 && counts.allowedTokens === 0;
  const problems: string[] = [];
  if (counts.rawMissingTokens > 0) problems.push(`model_raw_missing:${counts.rawMissingTokens}`);
  if (counts.executableMissingTokens > 0) problems.push(`model_executable_missing:${counts.executableMissingTokens}`);
  return {
    status: idle ? 'idle' : problems.length ? 'degraded' : 'healthy',
    healthy: problems.length === 0,
    idle,
    problems,
    ...counts,
  };
}

export async function paperEvidenceHealth(lookbackHours = 24, graceMinutes = 5) {
  if (!pool) return {
    status: 'unavailable', healthy: false, idle: true, problems: ['database_unavailable'],
    preliminaryTokens: 0, allowedTokens: 0, rawRows: 0, executableRows: 0,
    rawMissingTokens: 0, executableMissingTokens: 0,
    lookbackHours, graceMinutes, checkedAt: new Date().toISOString(),
  };
  try {
    const result = await pool.query(
      `WITH decisions AS (
         SELECT ca,bool_or(preliminary_pass) AS preliminary,bool_or(allow) AS allowed
           FROM signal_decisions
          WHERE model_version=$1
            AND evaluated_at>now()-($2||' hours')::interval
            AND evaluated_at<now()-($3||' minutes')::interval
          GROUP BY ca
       ), evidence AS (
         SELECT ca,
                bool_or(signal='model_raw') AS has_raw,
                bool_or(signal='model_executable') AS has_executable
           FROM paper_trades
          WHERE model_version=$1
            AND entry_at>now()-($2||' hours')::interval
          GROUP BY ca
       )
       SELECT COUNT(*) FILTER (WHERE decisions.preliminary)::int AS preliminary_tokens,
              COUNT(*) FILTER (WHERE decisions.allowed)::int AS allowed_tokens,
              COUNT(*) FILTER (WHERE evidence.has_raw)::int AS raw_rows,
              COUNT(*) FILTER (WHERE evidence.has_executable)::int AS executable_rows,
              COUNT(*) FILTER (WHERE decisions.preliminary AND COALESCE(evidence.has_raw,false)=false)::int AS raw_missing_tokens,
              COUNT(*) FILTER (WHERE decisions.allowed AND COALESCE(evidence.has_executable,false)=false)::int AS executable_missing_tokens
         FROM decisions LEFT JOIN evidence USING (ca)`,
      [MODEL_VERSION, String(Math.max(1, lookbackHours)), String(Math.max(1, graceMinutes))],
    );
    const row = result.rows[0] || {};
    const counts: EvidenceHealthCounts = {
      preliminaryTokens: Number(row.preliminary_tokens) || 0,
      allowedTokens: Number(row.allowed_tokens) || 0,
      rawRows: Number(row.raw_rows) || 0,
      executableRows: Number(row.executable_rows) || 0,
      rawMissingTokens: Number(row.raw_missing_tokens) || 0,
      executableMissingTokens: Number(row.executable_missing_tokens) || 0,
    };
    return { ...assessEvidenceHealth(counts), lookbackHours, graceMinutes, checkedAt: new Date().toISOString() };
  } catch (error) {
    recordPaperFailure('health_read', error);
    return {
      status: 'error', healthy: false, idle: false,
      problems: [`health_query_failed:${error instanceof Error ? error.message : String(error)}`],
      preliminaryTokens: 0, allowedTokens: 0, rawRows: 0, executableRows: 0,
      rawMissingTokens: 0, executableMissingTokens: 0,
      lookbackHours, graceMinutes, checkedAt: new Date().toISOString(),
    };
  }
}

let monitorStarted = false;
let lastAlarm = '';

export function startPaperEvidenceHealthMonitor() {
  if (!pool || monitorStarted) return;
  monitorStarted = true;
  const check = async () => {
    const health = await paperEvidenceHealth();
    const alarm = health.status === 'degraded' || health.status === 'error'
      ? health.problems.join(',')
      : '';
    if (alarm && alarm !== lastAlarm) {
      console.error('[paper:evidence-health] DEGRADED', JSON.stringify(health));
    } else if (!alarm && lastAlarm) {
      console.log('[paper:evidence-health] recovered');
    }
    lastAlarm = alarm;
  };
  const first = setTimeout(() => void check(), 60_000);
  first.unref();
  const timer = setInterval(() => void check(), 5 * 60_000);
  timer.unref();
}
