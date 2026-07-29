export interface BtcWorkerStatusMessage {
  type: 'btc-status';
  payload: Record<string, unknown>;
}

export interface BtcWorkerFatalMessage {
  type: 'btc-fatal';
  error: string;
  stack?: string | null;
  at?: number;
}

export type BtcWorkerMessage = BtcWorkerStatusMessage | BtcWorkerFatalMessage;

const unavailableFeed = (reason: string) => ({
  healthy: false,
  derivativesHealthy: false,
  referenceVenue: 'BYBIT-BTCUSDT',
  referenceAgeMs: null,
  coinbaseAgeMs: null,
  krakenAgeMs: null,
  spreadBps: null,
  markIndexBps: null,
  crossVenueBps: null,
  recentSequenceGap: false,
  blockers: [reason],
});

let latest: Record<string, unknown> = {
  market: 'BTC-PERP',
  mode: 'paper',
  executionEnabled: false,
  referenceVenue: 'BYBIT-BTCUSDT',
  engineState: 'worker_starting',
  prices: null,
  feed: unavailableFeed('BTC worker has not published a platform snapshot yet'),
  regime: null,
  crossAsset: null,
  portfolio: {
    activePnlUsd: 0,
    realizedPnlUsd: 0,
    totalNetPnlUsd: 0,
    hypotheticalEquityUsd: 100,
    activeMarginUsd: 0,
    activeNotionalUsd: 0,
    weightedLeverage: 0,
    activeCalls: 0,
    callsToday: 0,
  },
  activeCalls: [],
  recentCalls: [],
  winners: [],
  losers: [],
  strategies: [],
  latestCandidates: [],
  blockers: ['BTC worker has not published a platform snapshot yet'],
  updatedAt: new Date().toISOString(),
};

export function setBtcWorkerStatus(payload: Record<string, unknown>): void {
  latest = { ...payload, updatedAt: payload.updatedAt || new Date().toISOString() };
}

export function markBtcWorkerUnavailable(reason: string): void {
  latest = {
    ...latest,
    engineState: 'worker_restarting',
    feed: unavailableFeed(reason),
    blockers: [reason],
    updatedAt: new Date().toISOString(),
  };
}

export function markBtcWorkerFatal(error: string, stack?: string | null, at = Date.now()): void {
  const message = `BTC worker fatal startup: ${error}; supervised restart scheduled`;
  latest = {
    ...latest,
    engineState: 'worker_failed',
    feed: unavailableFeed(message),
    blockers: [message],
    lastFatalError: {
      message: error,
      stack: stack || null,
      at: new Date(at).toISOString(),
    },
    updatedAt: new Date().toISOString(),
  };
}

export async function getBtcStatus(): Promise<Record<string, unknown>> {
  return latest;
}
