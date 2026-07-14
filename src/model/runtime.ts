import { activeTokens } from '../store';
import { startTradeEventWriter } from '../market/trade-events';
import { startRegimeEngine } from './regime';
import { refreshSignalDecision, startSignalEnsemble } from './ensemble';
import { startSignalObservationCollector } from './observations';
import { startDecisionOutcomeTracker } from './outcomes';
import { startModelEvaluator } from './evaluation';
import { startPairwiseRankLearner } from './rank-learner';
import { finalizeSignalSchema } from './schema-finalizer';
import { validateSignalModelConfig } from './validate';

let started = false;
const diag = { startedAt: null as string | null, sweeps: 0, evaluated: 0, lastError: null as string | null };
export const modelRuntimeDiag = () => ({ ...diag });

export function startModelRuntime() {
  if (started) return;
  started = true;
  setTimeout(async () => {
    try {
      validateSignalModelConfig();
      await finalizeSignalSchema();
    } catch (error) {
      diag.lastError = (error as Error).message;
      console.error('[signal-v3] startup validation', diag.lastError);
      return;
    }
    startTradeEventWriter();
    startRegimeEngine();
    startSignalEnsemble();
    startPairwiseRankLearner();
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
    const timer = setInterval(sweep, 5_000); timer.unref();
    diag.startedAt = new Date().toISOString();
    console.log('[signal-v3] regime, graph, sequence, survival, learned ranking, execution and evaluation layers running');
  }, 12_000);
}
