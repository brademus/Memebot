import { cfg } from '../config';
import { TokenRecord } from '../types';
import { clamp01, round } from '../model/math';
import { rpcUrl, simulateTransaction } from './rpc-sim';
import { executionSettings, ExecutableQuote } from './execution';

/**
 * PRE-GRADUATION EXECUTION ADAPTER (PumpPortal Local Transaction API).
 *
 * Jupiter cannot route bonding-curve tokens, so before this adapter existed every
 * curve-phase timed entry sat at zero execution evidence and the promotion clock
 * never started. This adapter asks the venue that CAN answer: PumpPortal's
 * trade-local endpoint builds a real, unsigned pump.fun curve transaction for the
 * exact mint and size we intend. Building is free (their fee applies only when a
 * transaction is executed), and NOTHING HERE EVER SIGNS OR BROADCASTS.
 *
 * Honesty ladder, per the execution-truth workstream — each rung is recorded as
 * exactly what it is and never promoted to the rung above:
 *   1. buy transaction BUILT      -> the venue recognizes the mint and constructs
 *                                    a valid entry at our size (route evidence).
 *   2. sell transaction BUILT     -> a structural egress path exists (egress
 *                                    evidence; NOT proof we could exit a held
 *                                    position profitably).
 *   3. build STABILITY            -> a second buy build moments later still
 *                                    succeeds (curve still live, not migrating).
 *   4. buy SIMULATED              -> the RPC executed the unsigned transaction
 *                                    against live state with the configured
 *                                    shadow wallet as payer. A simulation blocked
 *                                    purely by an unfunded shadow wallet is
 *                                    recorded as blocked, never as success.
 * EVIDENCE, NOT ELIGIBILITY (review finding, 2026-07-28): a successful simulation
 * proves the transaction EXECUTES — it does not measure what it FILLS at. This
 * adapter cannot yet report expected token output, effective entry price, position
 * value, or curve slippage, so its results are recorded as unpriced evidence
 * ('curve_entry_simulated_unpriced' / 'curve_entry_built_unpriced') with
 * eligible=false ALWAYS. Nothing from this adapter may enter the executable
 * cohort until fill measurement (simulation post-balances) is implemented.
 * effectiveEntryPrice is null — there is no measured price to report.
 */

const TRADE_LOCAL_URL = 'https://pumpportal.fun/api/trade-local';
const PROBE_TIMEOUT_MS = 8_000;
const STABILITY_GAP_MS = 350;
const RATE_LIMIT_PER_MINUTE = 12;
const SELL_PROBE_TOKEN_AMOUNT = 1_000;
const PRIORITY_FEE_SOL = 0.0005;

const recentProbeTimestamps: number[] = [];
const diag = {
  probes: 0, buysBuilt: 0, sellsBuilt: 0, buildFailures: 0,
  simulationsOk: 0, simulationsBlockedUnfunded: 0, simulationsFailed: 0,
  rateLimited: 0, lastStatus: null as string | null, lastAt: null as string | null,
};
export const curveExecutionDiag = () => ({ ...diag });
export function __resetCurveExecutionForTest() {
  recentProbeTimestamps.length = 0;
  for (const key of Object.keys(diag) as Array<keyof typeof diag>) {
    (diag as any)[key] = typeof diag[key] === 'number' ? 0 : null;
  }
}

function rateLimited(now: number): boolean {
  while (recentProbeTimestamps.length && now - recentProbeTimestamps[0] > 60_000) recentProbeTimestamps.shift();
  if (recentProbeTimestamps.length >= RATE_LIMIT_PER_MINUTE) return true;
  recentProbeTimestamps.push(now);
  return false;
}

function shadowWallet(): string {
  return process.env.SIMULATION_WALLET || process.env.EXECUTION_SHADOW_PUBKEY || '';
}

function probeEnabled(): boolean {
  if (process.env.CURVE_PROBE_DISABLED === '1') return false;
  return (cfg().signal_model as any).curve_probe_enabled !== false;
}

interface CurveBuild {
  built: boolean;
  status: string;
  transactionBase64: string | null;
  latencyMs: number;
}

async function buildCurveTransaction(
  action: 'buy' | 'sell', mint: string, amount: number, denominatedInSol: boolean, signal: AbortSignal,
): Promise<CurveBuild> {
  const startedAt = Date.now();
  try {
    const response = await fetch(TRADE_LOCAL_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        publicKey: shadowWallet(),
        action, mint, amount,
        denominatedInSol: denominatedInSol ? 'true' : 'false',
        slippage: Math.max(1, Math.round(executionSettings.slippageBps / 100)),
        priorityFee: PRIORITY_FEE_SOL,
        pool: 'pump',
      }),
      signal,
    });
    if (!response.ok) {
      return { built: false, status: `curve_build_http_${response.status}`, transactionBase64: null, latencyMs: Date.now() - startedAt };
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length < 200) {
      // A rejection body (JSON error text) is much smaller than a real serialized transaction.
      return { built: false, status: 'curve_build_rejected', transactionBase64: null, latencyMs: Date.now() - startedAt };
    }
    return { built: true, status: 'curve_built', transactionBase64: bytes.toString('base64'), latencyMs: Date.now() - startedAt };
  } catch (error) {
    const status = error instanceof Error && error.name === 'AbortError' ? 'curve_build_timeout' : 'curve_build_error';
    return { built: false, status, transactionBase64: null, latencyMs: Date.now() - startedAt };
  }
}

function unfundedShadowError(error: string | null): boolean {
  const value = String(error || '').toLowerCase();
  return value.includes('insufficientfunds') || value.includes('insufficient funds')
    || value.includes('insufficient lamports') || value.includes('accountnotfound');
}

function curveFailure(status: string, startedAt: number, extras: Partial<ExecutableQuote> = {}): ExecutableQuote {
  diag.lastStatus = status; diag.lastAt = new Date().toISOString();
  return {
    eligible: false, status,
    effectiveEntryPrice: null, positionSol: null, positionUsd: null,
    quotedOutUsd: null, quotedOutAmount: null, priceImpact: null,
    slippageBps: executionSettings.slippageBps, feeLamports: null, router: 'pumpportal_curve',
    quoteTimeMs: Date.now() - startedAt, transactionBuilt: false,
    simulationOk: false, simulationError: null, executionScore: 0, routeStabilityBps: null,
    requestedPositionSol: executionSettings.positionSol, selectedRouter: 'pumpportal_curve',
    selectedMode: 'bonding_curve', unitsConsumed: null, probeSizes: [],
    ...extras,
  } as ExecutableQuote;
}

export async function curveQuoteExecutableEntry(
  token: TokenRecord, markPrice: number, startedAt: number,
  options?: { requireSimulation?: boolean },
): Promise<ExecutableQuote> {
  if (!probeEnabled()) return curveFailure('curve_probe_disabled', startedAt);
  if (!shadowWallet()) return curveFailure('curve_shadow_wallet_missing', startedAt);
  const requireSimulation = options?.requireSimulation ?? cfg().signal_model.require_transaction_simulation === true;
  if (requireSimulation && !rpcUrl()) return curveFailure('curve_rpc_missing', startedAt);
  const now = Date.now();
  if (rateLimited(now)) { diag.rateLimited++; return curveFailure('curve_probe_rate_limited', startedAt); }
  diag.probes++;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS * 3);
  try {
    const positionSol = executionSettings.positionSol;
    const buy = await buildCurveTransaction('buy', token.ca, positionSol, true, controller.signal);
    if (!buy.built || !buy.transactionBase64) { diag.buildFailures++; return curveFailure(buy.status, startedAt); }
    diag.buysBuilt++;

    // Egress evidence: the venue can construct a sell for this mint. This proves a
    // structural exit path exists — it is NOT a round-trip proof and is never
    // recorded as one (the shadow wallet holds no tokens to sell).
    const sell = await buildCurveTransaction('sell', token.ca, SELL_PROBE_TOKEN_AMOUNT, false, controller.signal);
    if (!sell.built) { diag.buildFailures++; return curveFailure('curve_sell_build_failed', startedAt, { transactionBuilt: true }); }
    diag.sellsBuilt++;

    // Stability: the curve is still accepting entries a moment later (a migrating
    // or completed curve fails its second build).
    await new Promise(resolve => setTimeout(resolve, STABILITY_GAP_MS));
    const repeat = await buildCurveTransaction('buy', token.ca, positionSol, true, controller.signal);
    const stable = repeat.built;
    if (!stable) return curveFailure('curve_route_unstable', startedAt, { transactionBuilt: true });

    let simulationOk = false;
    let simulationError: string | null = null;
    let unitsConsumed: number | null = null;
    if (rpcUrl()) {
      const simulation = await simulateTransaction(buy.transactionBase64, controller.signal);
      unitsConsumed = simulation.units;
      if (simulation.ok) { simulationOk = true; diag.simulationsOk++; }
      else if (unfundedShadowError(simulation.error)) {
        simulationError = 'curve_sim_blocked_shadow_unfunded';
        diag.simulationsBlockedUnfunded++;
      } else {
        simulationError = simulation.error;
        diag.simulationsFailed++;
      }
    } else {
      simulationError = 'curve_rpc_missing';
    }

    const simFactor = simulationOk ? 1 : 0;
    const executionScore = clamp01(0.5 * (requireSimulation ? simFactor : 1) + 0.25 * 1 + 0.25 * (stable ? 1 : 0));
    // eligible is ALWAYS false here: the fill is unmeasured (see module comment).
    const eligible = false;
    const evidenceComplete = requireSimulation ? simulationOk : true;
    const status = evidenceComplete
      ? (simulationOk ? 'curve_entry_simulated_unpriced' : 'curve_entry_built_unpriced')
      : (simulationError || 'curve_simulation_failed');
    diag.lastStatus = status; diag.lastAt = new Date().toISOString();
    return {
      eligible, status,
      effectiveEntryPrice: null,   // no measured fill price exists for the curve yet
      positionSol, positionUsd: null, quotedOutUsd: null, quotedOutAmount: null,
      priceImpact: null, slippageBps: executionSettings.slippageBps,
      feeLamports: Math.round(PRIORITY_FEE_SOL * 1_000_000_000), router: 'pumpportal_curve',
      quoteTimeMs: Date.now() - startedAt, transactionBuilt: true,
      simulationOk, simulationError, executionScore: round(executionScore),
      routeStabilityBps: stable ? 0 : null,
      requestedPositionSol: positionSol, selectedRouter: 'pumpportal_curve',
      selectedMode: 'bonding_curve', unitsConsumed,
      probeSizes: [{ sol: positionSol, status: buy.status, transactionBuilt: true, simulationOk, priceImpact: null }],
    } as ExecutableQuote;
  } catch (error) {
    const status = error instanceof Error && error.name === 'AbortError' ? 'curve_probe_timeout' : 'curve_probe_error';
    diag.buildFailures++;
    return curveFailure(status, startedAt);
  } finally { clearTimeout(timeout); }
}
