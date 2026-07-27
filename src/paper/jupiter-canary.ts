import { env } from '../config';
import { pool } from '../db';
import { heliusQuotaGuardDiag } from '../helius-quota-guard';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5Au17hunznbnx7qnk5V0Zm25ed4gJ4JSZiUa';
const CANARY_INTERVAL_MS = 24 * 60 * 60_000;
const INITIAL_DELAY_MS = 5000;
const CANARY_DEDUP_HOURS = 24;

interface CanaryResult {
  executed: boolean;
  timestamp: string;
  wallet: string | null;
  route: string | null;
  transactionBuilt: boolean;
  simulationOk: boolean;
  simulationError: string | null;
  unitsConsumed: number | null;
  details: string | null;
}

let lastCanaryResult: CanaryResult | null = null;
let lastCanaryAttemptAt: string | null = null;
let canaryExecuted = false;
let canaryScheduled = false;

async function testJupiterUnsignedBuild(
  inputMint: string,
  outputMint: string,
  amount: string,
): Promise<{ transaction: string | null; error: string | null }> {
  const apiKey = env.JUPITER_API_KEY || '';
  if (!apiKey) return { transaction: null, error: 'jupiter_api_key_missing' };

  const params = new URLSearchParams({
    inputMint,
    outputMint,
    amount,
    swapMode: 'ExactIn',
    slippageBps: '300',
  });

  if (env.SIMULATION_WALLET) {
    params.set('taker', env.SIMULATION_WALLET);
  }

  try {
    const response = await fetch(`https://api.jup.ag/swap/v2/order?${params}`, {
      headers: { 'x-api-key': apiKey },
      signal: AbortSignal.timeout(8000),
    });

    if (!response.ok) {
      return { transaction: null, error: `jupiter_http_${response.status}` };
    }

    const data: any = await response.json();
    if (data?.error || data?.errorMessage) {
      return { transaction: null, error: data.error || data.errorMessage };
    }

    const transaction = data.transaction || data.swapTransaction || data.tx;
    if (!transaction || typeof transaction !== 'string' || transaction.length < 50) {
      return { transaction: null, error: 'jupiter_transaction_not_built' };
    }

    return { transaction, error: null };
  } catch (error) {
    return { transaction: null, error: `jupiter_error: ${(error as Error).message.slice(0, 100)}` };
  }
}

async function simulateUnsignedTransaction(transaction: string): Promise<{ ok: boolean; error: string | null; units: number | null }> {
  // Prefer SOLANA_RPC_URL; check Helius quota circuit before using Helius RPC
  let rpcUrl = process.env.SOLANA_RPC_URL || '';

  if (!rpcUrl && env.HELIUS_API_KEY) {
    const heliusQuota = heliusQuotaGuardDiag();
    if (heliusQuota.circuitOpen) {
      return { ok: false, error: 'rpc_quota_blocked', units: null };
    }
    rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${env.HELIUS_API_KEY}`;
  }

  if (!rpcUrl) {
    return { ok: false, error: 'solana_rpc_missing', units: null };
  }

  try {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'simulateTransaction',
        params: [transaction, { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'processed' }],
      }),
      signal: AbortSignal.timeout(8000),
    });

    const data: any = await response.json();
    if (!response.ok || data.error) {
      return { ok: false, error: `simulation_rpc_${response.status || 'error'}`, units: null };
    }

    const error = data.result?.value?.err;
    return {
      ok: error == null,
      error: error == null ? null : `simulation_failed: ${JSON.stringify(error).slice(0, 100)}`,
      units: Number.isFinite(Number(data.result?.value?.unitsConsumed)) ? Number(data.result.value.unitsConsumed) : null,
    };
  } catch (error) {
    return { ok: false, error: `simulation_error: ${(error as Error).message.slice(0, 100)}`, units: null };
  }
}

async function loadLastCanaryResult(): Promise<CanaryResult | null> {
  if (!pool) return null;
  try {
    const today = new Date().toISOString().split('T')[0];
    const result = await pool.query(
      `SELECT result_json FROM jupiter_canary_history WHERE canary_day = $1`,
      [today],
    );
    if (result.rows.length > 0) {
      return result.rows[0].result_json;
    }
  } catch {
    // Table may not exist yet
  }
  return null;
}

async function persistCanaryResult(result: CanaryResult): Promise<void> {
  if (!pool) return;
  try {
    const canaryDay = new Date(result.timestamp).toISOString().split('T')[0];
    await pool.query(
      `INSERT INTO jupiter_canary_history (canary_day, executed_at, result_json)
       VALUES ($1, $2, $3)
       ON CONFLICT (canary_day) DO UPDATE SET
         result_json = $3,
         executed_at = $2`,
      [canaryDay, new Date(result.timestamp), JSON.stringify(result)],
    );
  } catch {
    // Table may not exist or other error; don't fail canary
  }
}

export async function runJupiterCanary(): Promise<CanaryResult> {
  const timestamp = new Date().toISOString();

  if (!env.JUPITER_API_KEY) {
    const result: CanaryResult = {
      executed: false,
      timestamp,
      wallet: null,
      route: null,
      transactionBuilt: false,
      simulationOk: false,
      simulationError: 'jupiter_api_key_missing',
      unitsConsumed: null,
      details: 'JUPITER_API_KEY not configured',
    };
    lastCanaryAttemptAt = timestamp;
    return result;
  }

  if (!env.SIMULATION_WALLET) {
    const result: CanaryResult = {
      executed: false,
      timestamp,
      wallet: null,
      route: null,
      transactionBuilt: false,
      simulationOk: false,
      simulationError: 'simulation_wallet_missing',
      unitsConsumed: null,
      details: 'SIMULATION_WALLET not configured',
    };
    lastCanaryAttemptAt = timestamp;
    return result;
  }

  // Check if we already have today's result (dedup within 24h)
  const existing = await loadLastCanaryResult();
  if (existing && existing.timestamp) {
    const hoursAgo = (Date.now() - new Date(existing.timestamp).getTime()) / 3_600_000;
    if (hoursAgo < CANARY_DEDUP_HOURS) {
      // Already have a result within 24h; skip rerun on redeploy
      lastCanaryResult = existing;
      lastCanaryAttemptAt = existing.timestamp;
      canaryExecuted = true;
      return existing;
    }
  }

  // Test SOL → USDC (high volume, liquid route)
  const amount = String(Math.floor(0.1 * 1_000_000_000)); // 0.1 SOL
  const { transaction, error: buildError } = await testJupiterUnsignedBuild(SOL_MINT, USDC_MINT, amount);

  if (buildError) {
    const result: CanaryResult = {
      executed: false,
      timestamp,
      wallet: env.SIMULATION_WALLET.slice(0, 8) + '…' + env.SIMULATION_WALLET.slice(-4),
      route: null,
      transactionBuilt: false,
      simulationOk: false,
      simulationError: buildError,
      unitsConsumed: null,
      details: `Transaction build failed: ${buildError}`,
    };
    lastCanaryAttemptAt = timestamp;
    lastCanaryResult = result;
    await persistCanaryResult(result);
    return result;
  }

  if (!transaction) {
    const result: CanaryResult = {
      executed: false,
      timestamp,
      wallet: env.SIMULATION_WALLET.slice(0, 8) + '…' + env.SIMULATION_WALLET.slice(-4),
      route: 'unknown',
      transactionBuilt: false,
      simulationOk: false,
      simulationError: 'transaction_not_built',
      unitsConsumed: null,
      details: 'Jupiter returned no transaction',
    };
    lastCanaryAttemptAt = timestamp;
    lastCanaryResult = result;
    await persistCanaryResult(result);
    return result;
  }

  // Simulate unsigned
  const simulation = await simulateUnsignedTransaction(transaction);

  const result: CanaryResult = {
    executed: true,
    timestamp,
    wallet: env.SIMULATION_WALLET.slice(0, 8) + '…' + env.SIMULATION_WALLET.slice(-4),
    route: 'SOL/USDC',
    transactionBuilt: true,
    simulationOk: simulation.ok,
    simulationError: simulation.error,
    unitsConsumed: simulation.units,
    details: simulation.ok
      ? `Unsigned simulation succeeded; ${simulation.units} compute units`
      : `Simulation failed: ${simulation.error}`,
  };

  lastCanaryAttemptAt = timestamp;
  lastCanaryResult = result;
  canaryExecuted = true;
  await persistCanaryResult(result);
  console.log(`[jupiter-canary] attempted: ${simulation.ok ? 'ok' : 'failed - ' + simulation.error}`);
  return result;
}

export function jupiterCanaryDiag() {
  return {
    configured: !!env.JUPITER_API_KEY && !!env.SIMULATION_WALLET,
    executed: canaryExecuted,
    lastAttemptAt: lastCanaryAttemptAt,
    lastResult: lastCanaryResult,
    supportsUnsignedSimulation: lastCanaryResult?.simulationOk || false,
  };
}

export async function initializeJupiterCanary(): Promise<void> {
  // Load persisted result from today if it exists
  const persisted = await loadLastCanaryResult();
  if (persisted) {
    lastCanaryResult = persisted;
    lastCanaryAttemptAt = persisted.timestamp;
    canaryExecuted = true;
  }
}

export function startJupiterCanary(): void {
  if (canaryScheduled || !env.JUPITER_API_KEY || !env.SIMULATION_WALLET) return;
  canaryScheduled = true;

  const initial = setTimeout(() => {
    void runJupiterCanary();
  }, INITIAL_DELAY_MS);
  initial.unref();

  const timer = setInterval(() => {
    void runJupiterCanary();
  }, CANARY_INTERVAL_MS);
  timer.unref();
}

