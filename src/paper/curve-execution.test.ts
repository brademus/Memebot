import test from 'node:test';
import assert from 'node:assert/strict';
import {
  base58Encode,
  curveQuoteExecutableEntry,
  __resetCurveExecutionForTest,
  curveExecutionDiag,
} from './curve-execution';
import { TokenRecord } from '../types';
import { setSolUsd } from '../state/sol-price';

const mintBytes = Buffer.alloc(32, 9);
const payerBytes = Buffer.alloc(32, 1);
const tokenAccountBytes = Buffer.alloc(32, 2);
const programBytes = Buffer.alloc(32, 3);
const mint = base58Encode(mintBytes);
const payer = base58Encode(payerBytes);
const token = {
  ca: mint,
  dex: 'pumpfun',
  gradAt: null,
  liquidityUsd: 1_000_000,
} as unknown as TokenRecord;
const realFetch = global.fetch;

function fakeTransactionBody(): ArrayBuffer {
  const serialized = Buffer.concat([
    Buffer.from([1]),              // signature count
    Buffer.alloc(64),              // unsigned signature placeholder
    Buffer.from([1, 0, 1]),        // one signer, one readonly unsigned account
    Buffer.from([3]),              // static account count
    payerBytes,
    tokenAccountBytes,
    programBytes,
    Buffer.alloc(32, 4),            // recent blockhash
    Buffer.from([0]),              // no instructions needed by the parser fixture
    Buffer.alloc(24),              // keep the body above rejection-size threshold
  ]);
  return serialized.buffer.slice(serialized.byteOffset, serialized.byteOffset + serialized.byteLength);
}

function accountData(bytes: Buffer, lamports: number) {
  return { data: [bytes.toString('base64'), 'base64'], executable: false, lamports, owner: '', rentEpoch: 0 };
}

function tokenAccount(amount: bigint): Buffer {
  const data = Buffer.alloc(165);
  mintBytes.copy(data, 0);
  data.writeBigUInt64LE(amount, 64);
  return data;
}

interface FetchScript {
  tradeLocal: Array<{ ok: boolean; status?: number; body?: ArrayBuffer }>;
  simulationErr?: unknown;
  omitPostAccounts?: boolean;
}

function scriptFetch(script: FetchScript) {
  let tradeLocalCalls = 0;
  const calls = { tradeLocal: 0, rpc: 0, getMultipleAccounts: 0, simulate: 0, getTokenSupply: 0 };
  global.fetch = (async (url: any, init?: any) => {
    const target = String(url);
    if (target.includes('pumpportal.fun/api/trade-local')) {
      calls.tradeLocal++;
      const step = script.tradeLocal[Math.min(tradeLocalCalls++, script.tradeLocal.length - 1)];
      return {
        ok: step.ok,
        status: step.status ?? (step.ok ? 200 : 500),
        arrayBuffer: async () => step.body ?? fakeTransactionBody(),
        json: async () => ({}),
      } as any;
    }

    calls.rpc++;
    const request = JSON.parse(String(init?.body || '{}'));
    if (request.method === 'getMultipleAccounts') {
      calls.getMultipleAccounts++;
      return {
        ok: true, status: 200,
        json: async () => ({ result: { value: [
          accountData(Buffer.alloc(0), 2_000_000_000),
          accountData(tokenAccount(0n), 2_039_280),
        ] } }),
      } as any;
    }
    if (request.method === 'simulateTransaction') {
      calls.simulate++;
      const value: any = { err: script.simulationErr ?? null, unitsConsumed: 120_000 };
      if (!script.omitPostAccounts && value.err == null) {
        value.accounts = [
          accountData(Buffer.alloc(0), 999_000_000),
          accountData(tokenAccount(1_000_000_000n), 2_039_280),
        ];
      }
      return { ok: true, status: 200, json: async () => ({ result: { value } }) } as any;
    }
    if (request.method === 'getTokenSupply') {
      calls.getTokenSupply++;
      return {
        ok: true, status: 200,
        json: async () => ({ result: { value: { amount: '1000000000000000', decimals: 6 } } }),
      } as any;
    }
    throw new Error(`unexpected RPC method ${request.method}`);
  }) as any;
  return calls;
}

function withEnv(run: () => Promise<void>) {
  return async () => {
    const previousWallet = process.env.SIMULATION_WALLET;
    const previousRpc = process.env.SOLANA_RPC_URL;
    process.env.SIMULATION_WALLET = payer;
    process.env.SOLANA_RPC_URL = 'https://rpc.test.invalid';
    setSolUsd(100);
    __resetCurveExecutionForTest();
    try { await run(); } finally {
      if (previousWallet === undefined) delete process.env.SIMULATION_WALLET; else process.env.SIMULATION_WALLET = previousWallet;
      if (previousRpc === undefined) delete process.env.SOLANA_RPC_URL; else process.env.SOLANA_RPC_URL = previousRpc;
      global.fetch = realFetch;
    }
  };
}

test('curve adapter: full ladder measures the unsigned fill and may become execution eligible', withEnv(async () => {
  const calls = scriptFetch({ tradeLocal: [{ ok: true }, { ok: true }, { ok: true }] });
  const quote = await curveQuoteExecutableEntry(token, 0.1, Date.now(), { requireSimulation: true });
  assert.equal(quote.status, 'curve_executable_simulated_priced');
  assert.equal(quote.eligible, true);
  assert.ok(quote.effectiveEntryPrice && Math.abs(quote.effectiveEntryPrice - 0.1001) < 0.000001);
  assert.equal(quote.quotedOutAmount, '1000000000');
  assert.ok(quote.positionUsd && Math.abs(quote.positionUsd - 100.1) < 0.000001);
  assert.equal(quote.transactionBuilt, true);
  assert.equal(quote.simulationOk, true);
  assert.equal(quote.router, 'pumpportal_curve');
  assert.equal(calls.tradeLocal, 3); // buy, sell egress, stability repeat
  assert.equal(calls.getMultipleAccounts, 2);
  assert.equal(calls.simulate, 2);
  assert.equal(calls.getTokenSupply, 2);
  assert.equal(curveExecutionDiag().pricedFills, 1);
}));

test('curve adapter: unfunded shadow wallet blocks simulation honestly, never claims success', withEnv(async () => {
  scriptFetch({ tradeLocal: [{ ok: true }, { ok: true }, { ok: true }], simulationErr: { InsufficientFundsForFee: {} } });
  const quote = await curveQuoteExecutableEntry(token, 0.1, Date.now(), { requireSimulation: true });
  assert.equal(quote.eligible, false);
  assert.equal(quote.status, 'curve_sim_blocked_shadow_unfunded');
  assert.equal(quote.transactionBuilt, true);
  assert.equal(quote.simulationOk, false);
  assert.equal(curveExecutionDiag().simulationsBlockedUnfunded, 1);
}));

test('curve adapter: missing post-account deltas stays ineligible even when simulation is optional', withEnv(async () => {
  scriptFetch({ tradeLocal: [{ ok: true }, { ok: true }, { ok: true }], omitPostAccounts: true });
  const quote = await curveQuoteExecutableEntry(token, 0.1, Date.now(), { requireSimulation: false });
  assert.equal(quote.eligible, false);
  assert.equal(quote.status, 'curve_fill_post_accounts_missing');
  assert.equal(quote.simulationOk, false);
}));

test('curve adapter: venue rejection is a typed build failure', withEnv(async () => {
  scriptFetch({ tradeLocal: [{ ok: false, status: 500 }] });
  const quote = await curveQuoteExecutableEntry(token, 0.1, Date.now(), { requireSimulation: true });
  assert.equal(quote.eligible, false);
  assert.equal(quote.status, 'curve_build_http_500');
  assert.equal(quote.transactionBuilt, false);
}));

test('curve adapter: missing sell build denies eligibility because egress is unproven', withEnv(async () => {
  scriptFetch({ tradeLocal: [{ ok: true }, { ok: false, status: 400 }] });
  const quote = await curveQuoteExecutableEntry(token, 0.1, Date.now(), { requireSimulation: true });
  assert.equal(quote.eligible, false);
  assert.equal(quote.status, 'curve_sell_build_failed');
  assert.equal(quote.transactionBuilt, true);
}));

test('curve adapter: a small rejection body is not mistaken for a transaction', withEnv(async () => {
  scriptFetch({ tradeLocal: [{ ok: true, body: new Uint8Array(40).buffer }] });
  const quote = await curveQuoteExecutableEntry(token, 0.1, Date.now(), { requireSimulation: true });
  assert.equal(quote.status, 'curve_build_rejected');
}));
