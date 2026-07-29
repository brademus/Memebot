export interface BtcWorkerStatusMessage {
  type: 'btc-status';
  payload: Record<string, unknown>;
}

let latest: Record<string, unknown> = {
  market: 'BTC-USD',
  mode: 'paper',
  enabled: true,
  strategyVersion: 'btc-momentum-v1.0.0',
  strategyName: 'Regime-Filtered High-Volume Momentum Retest',
  engineState: 'worker_starting',
  price: null,
  validationPrice: null,
  feed: {
    healthy: false,
    coinbaseAgeMs: null,
    krakenAgeMs: null,
    spreadBps: null,
    divergenceBps: null,
    recentSequenceGap: false,
    blockers: ['BTC worker has not published a status snapshot yet'],
  },
  session: { active: false, window: 'Weekdays 12:00-21:00 UTC' },
  limits: { dailyCalls: 0, dailyLosses: 0, maxCalls: 2, maxLosses: 2 },
  warmup: { m1: 0, m5: 0, m15: 0, h1: 0, h4: 0 },
  setup: null,
  blockers: ['BTC worker has not published a status snapshot yet'],
  activeCall: null,
  recentCalls: [],
  updatedAt: new Date().toISOString(),
};

export function setBtcWorkerStatus(payload: Record<string, unknown>): void {
  latest = { ...payload, updatedAt: payload.updatedAt || new Date().toISOString() };
}

export function markBtcWorkerUnavailable(reason: string): void {
  latest = {
    ...latest,
    engineState: 'worker_restarting',
    feed: {
      healthy: false,
      coinbaseAgeMs: null,
      krakenAgeMs: null,
      spreadBps: null,
      divergenceBps: null,
      recentSequenceGap: false,
      blockers: [reason],
    },
    blockers: [reason],
    updatedAt: new Date().toISOString(),
  };
}

export async function getBtcStatus(): Promise<Record<string, unknown>> {
  return latest;
}
