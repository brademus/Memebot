import { cfg } from '../config';
import {
  assessEntryTiming,
  convictionQueueStatus,
  isConvictionCandidate,
} from '../scoring/conviction-queue';
import { rankToken } from '../scoring/rank';
import { activeTokens } from '../store';
import { weightedSmartHits } from '../wallets/tracker';

/**
 * Read-only API projection of the backend-owned conviction queue.
 *
 * Lifecycle mutations are intentionally restricted to refreshConvictionQueue(),
 * which is called by the worker. HTTP reads must never admit, evict, supersede, or
 * restart a token's observation hold.
 */
export function currentConvictions(now = Date.now()) {
  const config = cfg().bestbuys;
  return activeTokens()
    .filter(token => isConvictionCandidate(token.ca))
    .map(token => {
      const conviction = convictionQueueStatus(token.ca, now);
      const rank = rankToken(token);
      const smart = weightedSmartHits(token.smartHits, config.smart_lane_window_min * 60_000);
      const model = token.modelDecision;
      const entry = assessEntryTiming(token, now, conviction);
      return {
        ca: token.ca,
        symbol: token.symbol,
        grade: rank.grade,
        timing: rank.timing,
        lane: conviction.lane,
        label: model
          ? `${rank.label} · v3 ${(model.targetBeforeStopProbability * 100).toFixed(1)}% target-before-loss · ${(model.cohortPercentile * 100).toFixed(0)}th percentile`
          : `${rank.label} · v3 evidence collecting`,
        confidence: rank.confidence,
        score: token.score,
        peakScore: token.peakScore,
        heldMin: Math.round(conviction.heldSeconds / 60),
        heldSeconds: Math.round(conviction.heldSeconds),
        minimumHoldSeconds: conviction.minimumHoldSeconds,
        holdReady: conviction.holdReady,
        cautions: rank.cautions,
        waitingFor: entry.blockers,
        entryReady: entry.ready,
        liq: Math.round(token.liquidityUsd),
        buys: token.buys5m,
        sells: token.sells5m,
        smart: smart.wallets,
        smartElite: smart.elite,
        pair: token.pairAddress,
        model: model ? {
          version: model.modelVersion,
          targetBeforeStop: model.targetBeforeStopProbability,
          downside: model.downsideProbability,
          expectedValue: model.expectedValue,
          uncertainty: model.uncertainty,
          percentile: model.cohortPercentile,
          regime: model.regime.kind,
          execution: model.execution,
        } : null,
      };
    })
    .sort((left, right) => right.heldSeconds - left.heldSeconds || right.score - left.score);
}

export const currentBestBuys = currentConvictions;
