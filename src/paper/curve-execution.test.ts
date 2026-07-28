import test from 'node:test';
import assert from 'node:assert/strict';
import { curveQuoteExecutableEntry, __resetCurveExecutionForTest, curveExecutionDiag } from './curve-execution';
import { TokenRecord } from '../types';

const token = { ca: 'CurveMint1111111111111111111111111111111111', dex: 'pumpfun', gradAt: null } as unknown as TokenRecord;
const realFetch = global.fetch;

function fakeTransactionBody(): ArrayBuffer {
  return new Uint8Array(400).fill(7).buffer;
}

interface FetchScript {
  tradeLocal: Array<{ ok: boolean; status?: number; body?: ArrayBuffer }>;
  rpc?: { err: unknown };
}

function scriptFetch(script: FetchScript) {
  let tradeLocalCalls = 0;
  const calls = { tradeLocal: 0, rpc: 0 };
  global.fetch = (async (url: any, init?: any) => {
    const target = String(url);
    if (target.includes('pumpportal.fun/api/trade-local')) {
      calls.tradeLocal++;
      const step = script.tradeLocal[Math.min(tradeLocalCalls++, script.tradeLocal.length - 1)];
      return {
        ok: step.ok, status: step.status ?? (step.ok ? 200 : 500),
        arrayBuffer: async () => step.body ?? fakeTransactionBody(),
        json: async () => ({}),
      } as any;
    }
    calls.rpc++;
    return {
      ok: true, status: 200,
      json: async () => ({ result: { value: { err: script.rpc?.err ?? null, unitsConsumed: 5000 } } }),
    } as any;
  }) as any;
  return calls;
}

function withEnv(run: () => Promise<void>) {
  return async () => {
    const previousWallet = process.env.SIMULATION_WALLET;
    const previousRpc = process.env.SOLANA_RPC_URL;
    process.env.SIMULATION_WALLET = 'ShadowWa11etPubkey111111111111111111111111';
    process.env.SOLANA_RPC_URL = 'https://rpc.test.invalid';
    __resetCurveExecutionForTest();
    try { await run(); } finally {
      if (previousWallet === undefined) delete process.env.SIMULATION_WALLET; else process.env.SIMULATION_WALLET = previousWallet;
      if (previousRpc === undefined) delete process.env.SOLANA_RPC_URL; else process.env.SOLANA_RPC_URL = previousRpc;
      global.fetch = realFetch;
    }
  };
}

test('curve adapter: full ladder yields curve_executable_simulated and is eligible', withEnv(async () => {
  const calls = scriptFetch({ tradeLocal: [{ ok: true }, { ok: true }, { ok: true }], rpc: { err: null } });
  const quote = await curveQuoteExecutableEntry(token, 0.00005, Date.now(), { requireSimulation: true });
  assert.equal(quote.status, 'curve_executable_simulated');
  assert.equal(quote.eligible, true);
  assert.equal(quote.transactionBuilt, true);
  assert.equal(quote.simulationOk, true);
  assert.equal(quote.router, 'pumpportal_curve');
  assert.equal(calls.tradeLocal, 3);   // buy, sell egress, stability repeat
  assert.equal(calls.rpc, 1);
}));

test('curve adapter: unfunded shadow wallet blocks simulation honestly, never claims success', withEnv(async () => {
  scriptFetch({ tradeLocal: [{ ok: true }, { ok: true }, { ok: true }], rpc: { err: { InsufficientFundsForFee: {} } } });
  const quote = await curveQuoteExecutableEntry(token, 0.00005, Date.now(), { requireSimulation: true });
  assert.equal(quote.eligible, false);
  assert.equal(quote.status, 'curve_sim_blocked_shadow_unfunded');
  assert.equal(quote.transactionBuilt, true);   // build evidence stands on its own rung
  assert.equal(quote.simulationOk, false);
  assert.equal(curveExecutionDiag().simulationsBlockedUnfunded, 1);
}));

test('curve adapter: when simulation is not required, built ladder is eligible as curve_executable_built', withEnv(async () => {
  scriptFetch({ tradeLocal: [{ ok: true }, { ok: true }, { ok: true }], rpc: { err: { InsufficientFundsForFee: {} } } });
  const quote = await curveQuoteExecutableEntry(token, 0.00005, Date.now(), { requireSimulation: false });
  assert.equal(quote.eligible, true);
  assert.equal(quote.status, 'curve_executable_built');
  assert.equal(quote.simulationOk, false);
}));

test('curve adapter: venue rejection is a typed build failure', withEnv(async () => {
  scriptFetch({ tradeLocal: [{ ok: false, status: 500 }] });
  const quote = await curveQuoteExecutableEntry(token, 0.00005, Date.now(), { requireSimulation: true });
  assert.equal(quote.eligible, false);
  assert.equal(quote.status, 'curve_build_http_500');
  assert.equal(quote.transactionBuilt, false);
}));

test('curve adapter: missing sell build denies eligibility because egress is unproven', withEnv(async () => {
  scriptFetch({ tradeLocal: [{ ok: true }, { ok: false, status: 400 }] });
  const quote = await curveQuoteExecutableEntry(token, 0.00005, Date.now(), { requireSimulation: true });
  assert.equal(quote.eligible, false);
  assert.equal(quote.status, 'curve_sell_build_failed');
  assert.equal(quote.transactionBuilt, true);
}));

test('curve adapter: a small rejection body is not mistaken for a transaction', withEnv(async () => {
  scriptFetch({ tradeLocal: [{ ok: true, body: new Uint8Array(40).buffer }] });
  const quote = await curveQuoteExecutableEntry(token, 0.00005, Date.now(), { requireSimulation: true });
  assert.equal(quote.status, 'curve_build_rejected');
}));
