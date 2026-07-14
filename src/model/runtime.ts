import { activeTokens } from '../store';
import { startTradeEventWriter } from '../market/trade-events';
import { startRegimeEngine } from './regime';
import { refreshSignalDecision, startSignalEnsemble } from './ensemble';
import { startSignalObservationCollector } from './observations';
import { startDecisionOutcomeTracker } from './outcomes';
import { startModelEvaluator } from './evaluation';

let started = false;
const diag = { startedAt: null as string | null, sweeps: 0, evaluated: 0, lastError: null as string | null };
export const modelRuntimeDiag = () => ({ ...diag });

export function startModelRuntime() {
  if (started) return;
  started = true;
  // index.ts initializes Postgres asynchronously when imported. Delay the v3 loops so
  // schema-v3 is guaranteed to exist before their first writes, while trade events can
  // already accumulate in the in-memory buffer.
  setTimeout(() => {
    startTradeEventWriter();
    startRegimeEngine();
    startSignalEnsemble();
    startSignalObservationCollector();
    startDecisionOutcomeTracker();
    startModelEvaluator();
    const sweep = () => {
      diag.sweeps++;
      for (const token of activeTokens()) {
        if (token.score < 25) continue;
        refreshSignalDecision(token).then(decision => { if (decision) diag.evaluated++; }).catch(error => {
          diag.lastError = (error as Error).message;
        });
      }
    };
    sweep();
    const timer = setInterval(sweep, 5_000);
    timer.unref();
    diag.startedAt = new Date().toISOString();
    console.log('[signal-v3] regime, graph, sequence, survival, ranking, execution and evaluation layers running');
  }, 12_000);
}
