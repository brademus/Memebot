import { cfg } from '../config';
import { ExecutionEvidence, TokenRecord } from '../types';
import { clamp01, round } from '../model/math';

const SOL_MINT = 'So11111111111111111111111111111111111111112';

export const executionSettings = {
  get requireQuote() { return cfg().paper.require_jupiter_quote; },
  get targetMultiple() { return cfg().paper.target_multiple; },
  get stopMultiple() { return cfg().paper.stop_multiple; },
  get maxHoldHours() { return cfg().paper.max_hold_hours; },
  get positionSol() { return cfg().paper.position_sol; },
  get maxLiquidityPct() { return cfg().paper.max_liquidity_pct; },
  get minPositionUsd() { return cfg().paper.min_position_usd; },
  get slippageBps() { return Math.round(cfg().paper.slippage_bps); },
  get maxPriceImpact() { return cfg().paper.max_price_impact_pct; },
  get quoteTimeoutMs() { return Math.round(cfg().paper.quote_timeout_ms); },
  get minForwardSamples() { return Math.round(cfg().paper.min_forward_samples_per_lane); },
};

interface Probe {
  sol: number;
  status: string;
  router: string | null;
  mode: string | null;
  priceImpact: number | null;
  inUsd: number | null;
  outUsd: number | null;
  outAmount: string | null;
  thresholdOutUsd: number | null;
  transactionBuilt: boolean;
  simulationOk: boolean;
  simulationError: string | null;
  unitsConsumed: number | null;
  fees: number | null;
  slippageBps: number;
}

export interface ExecutableQuote extends ExecutionEvidence {
  effectiveEntryPrice: number | null;
  positionSol: number | null;
  positionUsd: number | null;
  quotedOutUsd: number | null;
  quotedOutAmount: string | null;
  feeLamports: number | null;
  router: string | null;
  quoteTimeMs: number;
  slippageBps: number;
}

export interface ExecutableExitQuote {
  eligible: boolean;
  status: string;
  proceedsUsd: number | null;
  outputSol: number | null;
  priceImpact: number | null;
  feeLamports: number | null;
  router: string | null;
  quoteTimeMs: number;
  transactionBuilt: boolean;
  simulationOk: boolean;
  simulationError: string | null;
  unitsConsumed: number | null;
  executionScore: number;
  mode: string | null;
}

function rpcUrl(): string {
  if (process.env.SOLANA_RPC_URL) return process.env.SOLANA_RPC_URL;
  return process.env.HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}` : '';
}

async function requestOrder(inputMint: string, outputMint: string, amount: string, signal: AbortSignal) {
  const apiKey = process.env.JUPITER_API_KEY || '';
  const taker = process.env.SIMULATION_WALLET || '';
  const params = new URLSearchParams({
    inputMint, outputMint, amount, swapMode: 'ExactIn',
    slippageBps: String(executionSettings.slippageBps),
  });
  if (taker) params.set('taker', taker);
  const response = await fetch(`https://api.jup.ag/swap/v2/order?${params}`, {
    headers: { 'x-api-key': apiKey }, signal,
  });
  const data: any = await response.json().catch(() => ({}));
  return { response, data };
}

async function simulateTransaction(transaction: string, signal: AbortSignal): Promise<{ ok: boolean; error: string | null; units: number | null }> {
  const url = rpcUrl();
  if (!url) return { ok: false, error: 'solana_rpc_missing', units: null };
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'simulateTransaction',
      params: [transaction, { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'processed' }],
    }),
    signal,
  });
  const data: any = await response.json().catch(() => ({}));
  if (!response.ok || data.error) return { ok: false, error: `simulation_rpc_${response.status || 'error'}`, units: null };
  const error = data.result?.value?.err;
  return {
    ok: error == null,
    error: error == null ? null : `simulation_failed:${JSON.stringify(error).slice(0, 240)}`,
    units: Number.isFinite(Number(data.result?.value?.unitsConsumed)) ? Number(data.result.value.unitsConsumed) : null,
  };
}

function feeLamports(data: any): number {
  return [data.signatureFeeLamports, data.prioritizationFeeLamports, data.rentFeeLamports]
    .reduce((sum, value) => sum + Math.max(0, Number(value) || 0), 0);
}
function thresholdRatio(data: any): number {
  const output = Number(data.outAmount);
  const threshold = Number(data.otherAmountThreshold);
  return Number.isFinite(threshold) && threshold > 0 && Number.isFinite(output) && output > 0
    ? Math.min(1, threshold / output)
    : Math.max(0.01, 1 - executionSettings.slippageBps / 10_000);
}
function transactionFrom(data: any): string | null {
  const transaction = data.transaction || data.swapTransaction || data.tx;
  return typeof transaction === 'string' && transaction.length > 50 ? transaction : null;
}

async function probeSize(tokenMint: string, sol: number, controller: AbortController): Promise<Probe> {
  const amount = String(Math.max(1, Math.floor(sol * 1_000_000_000)));
  const { response, data } = await requestOrder(SOL_MINT, tokenMint, amount, controller.signal);
  if (!response.ok) return emptyProbe(sol, `jupiter_http_${response.status}`);
  if (data?.error || data?.errorMessage || !data?.outAmount) return emptyProbe(sol, 'jupiter_no_route');
  const inUsd = Number(data.inUsdValue);
  const outUsd = Number(data.outUsdValue);
  const outAmount = String(data.outAmount || '');
  const impact = Math.abs(Number(data.priceImpact ?? data.priceImpactPct ?? 0));
  if (![inUsd, outUsd, impact].every(Number.isFinite) || inUsd <= 0 || outUsd <= 0 || !/^\d+$/.test(outAmount))
    return emptyProbe(sol, 'jupiter_invalid_quote');
  const transaction = transactionFrom(data);
  const requireSimulation = cfg().signal_model.require_transaction_simulation;
  const simulation = transaction
    ? await simulateTransaction(transaction, controller.signal)
    : { ok: !requireSimulation, error: requireSimulation ? 'transaction_not_built' : null, units: null };
  return {
    sol,
    status: !transaction && requireSimulation ? 'transaction_not_built' : simulation.ok ? 'simulated_route' : simulation.error || 'simulation_failed',
    router: data.router || null, mode: data.mode || data.swapType || null,
    priceImpact: impact, inUsd, outUsd, outAmount,
    thresholdOutUsd: outUsd * thresholdRatio(data), transactionBuilt: !!transaction,
    simulationOk: simulation.ok, simulationError: simulation.error, unitsConsumed: simulation.units,
    fees: feeLamports(data), slippageBps: Number(data.slippageBps) || executionSettings.slippageBps,
  };
}

export async function quoteExecutableEntry(token: TokenRecord, markPrice: number): Promise<ExecutableQuote> {
  const startedAt = Date.now();
  if (!process.env.JUPITER_API_KEY) return failedEntry('jupiter_api_key_missing', startedAt);
  if (!process.env.SIMULATION_WALLET && cfg().signal_model.require_transaction_simulation)
    return failedEntry('simulation_wallet_missing', startedAt);
  if (!rpcUrl() && cfg().signal_model.require_transaction_simulation) return failedEntry('solana_rpc_missing', startedAt);
  if (!token.ca || !markPrice || markPrice <= 0) return failedEntry('invalid_mark', startedAt);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(8_000, executionSettings.quoteTimeoutMs * 4));
  try {
    const configured = cfg().signal_model.probe_sizes_sol || [executionSettings.positionSol];
    const sizes = [...new Set([...configured, executionSettings.positionSol].map(value => round(value, 4)))]
      .filter(value => value > 0).sort((left, right) => left - right).slice(0, 5);
    const probes: Probe[] = [];
    for (const size of sizes) probes.push(await probeSize(token.ca, size, controller));
    const selected = [...probes].sort((left, right) => Math.abs(left.sol - executionSettings.positionSol) - Math.abs(right.sol - executionSettings.positionSol))[0];
    if (!selected || selected.inUsd == null || selected.outUsd == null || !selected.outAmount)
      return failedEntry(selected?.status || 'jupiter_no_route', startedAt, probes);

    const maxPositionUsd = token.liquidityUsd > 0 ? token.liquidityUsd * executionSettings.maxLiquidityPct : Number.POSITIVE_INFINITY;
    if (selected.inUsd < executionSettings.minPositionUsd || selected.inUsd > maxPositionUsd * 1.01)
      return failedEntry('position_outside_liquidity_budget', startedAt, probes, selected);

    await new Promise(resolve => setTimeout(resolve, 350));
    const repeat = await probeSize(token.ca, selected.sol, controller);
    const firstOut = Number(selected.outAmount);
    const secondOut = Number(repeat.outAmount);
    const routeStabilityBps = firstOut > 0 && secondOut > 0 ? Math.abs(secondOut - firstOut) / firstOut * 10_000 : null;
    const impact = selected.priceImpact ?? 1;
    const allSuccessful = probes.filter(probe => probe.simulationOk && probe.transactionBuilt).length / Math.max(1, probes.length);
    const stabilityScore = routeStabilityBps == null ? 0 : clamp01(1 - routeStabilityBps / cfg().signal_model.route_stability_max_bps);
    const impactScore = clamp01(1 - impact / Math.max(0.0001, executionSettings.maxPriceImpact));
    const executionScore = clamp01(0.45 * (selected.simulationOk ? 1 : 0) + 0.20 * allSuccessful + 0.20 * stabilityScore + 0.15 * impactScore);
    const fees = selected.fees || 0;
    const impliedSolUsd = selected.inUsd / selected.sol;
    const totalCostUsd = selected.inUsd + fees / 1_000_000_000 * impliedSolUsd;
    const minimumOutUsd = selected.thresholdOutUsd || selected.outUsd;
    const effectiveEntryPrice = markPrice * totalCostUsd / minimumOutUsd;
    const stable = routeStabilityBps != null && routeStabilityBps <= cfg().signal_model.route_stability_max_bps;
    const eligible = selected.transactionBuilt && selected.simulationOk && impact <= executionSettings.maxPriceImpact
      && stable && executionScore >= cfg().signal_model.min_execution_score;
    const status = !selected.transactionBuilt ? 'transaction_not_built'
      : !selected.simulationOk ? selected.simulationError || 'simulation_failed'
      : impact > executionSettings.maxPriceImpact ? 'price_impact_too_high'
      : !stable ? 'route_unstable'
      : executionScore < cfg().signal_model.min_execution_score ? 'execution_score_too_low'
      : 'executable_simulated';
    return {
      eligible, status, effectiveEntryPrice: Number.isFinite(effectiveEntryPrice) ? effectiveEntryPrice : null,
      positionSol: selected.sol, positionUsd: totalCostUsd, quotedOutUsd: minimumOutUsd,
      quotedOutAmount: selected.outAmount, priceImpact: selected.priceImpact,
      slippageBps: selected.slippageBps, feeLamports: fees, router: selected.router,
      quoteTimeMs: Date.now() - startedAt, transactionBuilt: selected.transactionBuilt,
      simulationOk: selected.simulationOk, simulationError: selected.simulationError,
      executionScore: round(executionScore), routeStabilityBps: routeStabilityBps == null ? null : round(routeStabilityBps, 1),
      requestedPositionSol: executionSettings.positionSol, selectedRouter: selected.router, selectedMode: selected.mode,
      unitsConsumed: selected.unitsConsumed,
      probeSizes: probes.map(toPublicProbe),
    };
  } catch (error) {
    const status = error instanceof Error && error.name === 'AbortError' ? 'jupiter_timeout' : 'jupiter_error';
    return failedEntry(status, startedAt);
  } finally { clearTimeout(timeout); }
}

export async function quoteExecutableExit(tokenMint: string, tokenAmountRaw: string): Promise<ExecutableExitQuote> {
  const startedAt = Date.now();
  if (!process.env.JUPITER_API_KEY) return failedExit('jupiter_api_key_missing', startedAt);
  if (!process.env.SIMULATION_WALLET && cfg().signal_model.require_transaction_simulation) return failedExit('simulation_wallet_missing', startedAt);
  if (!tokenMint || !/^\d+$/.test(tokenAmountRaw) || tokenAmountRaw === '0') return failedExit('invalid_exit_amount', startedAt);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(8_000, executionSettings.quoteTimeoutMs * 2));
  try {
    const { response, data } = await requestOrder(tokenMint, SOL_MINT, tokenAmountRaw, controller.signal);
    if (!response.ok) return failedExit(`jupiter_exit_http_${response.status}`, startedAt);
    if (data?.error || data?.errorMessage || !data?.outAmount) return failedExit('jupiter_exit_no_route', startedAt);
    const outUsd = Number(data.outUsdValue), outputRaw = Number(data.outAmount), inUsd = Number(data.inUsdValue);
    const impact = Math.abs(Number(data.priceImpact ?? data.priceImpactPct ?? 0));
    if (![outUsd, outputRaw, inUsd, impact].every(Number.isFinite) || outUsd <= 0 || outputRaw <= 0 || inUsd <= 0)
      return failedExit('jupiter_exit_invalid_quote', startedAt);
    const transaction = transactionFrom(data);
    const requireSimulation = cfg().signal_model.require_transaction_simulation;
    const simulation = transaction ? await simulateTransaction(transaction, controller.signal)
      : { ok: !requireSimulation, error: requireSimulation ? 'transaction_not_built' : null, units: null };
    const fees = feeLamports(data);
    const minimumOutUsd = outUsd * thresholdRatio(data);
    const outputSol = outputRaw / 1_000_000_000;
    const impliedSolUsd = outUsd / Math.max(outputSol, 1e-12);
    const proceedsUsd = Math.max(0, minimumOutUsd - fees / 1_000_000_000 * impliedSolUsd);
    const executionScore = clamp01(0.65 * (simulation.ok ? 1 : 0) + 0.20 * (transaction ? 1 : 0)
      + 0.15 * clamp01(1 - impact / Math.max(0.0001, executionSettings.maxPriceImpact)));
    const eligible = !!transaction && simulation.ok && impact <= executionSettings.maxPriceImpact
      && executionScore >= cfg().signal_model.min_execution_score;
    const status = !transaction ? 'jupiter_exit_transaction_not_built'
      : !simulation.ok ? `jupiter_exit_${simulation.error || 'simulation_failed'}`
      : impact > executionSettings.maxPriceImpact ? 'jupiter_exit_price_impact_too_high'
      : eligible ? 'executable_exit_simulated' : 'jupiter_exit_execution_score_too_low';
    return {
      eligible, status, proceedsUsd, outputSol, priceImpact: impact, feeLamports: fees,
      router: data.router || null, quoteTimeMs: Date.now() - startedAt,
      transactionBuilt: !!transaction, simulationOk: simulation.ok, simulationError: simulation.error,
      unitsConsumed: simulation.units, executionScore: round(executionScore), mode: data.mode || data.swapType || null,
    };
  } catch (error) {
    return failedExit(error instanceof Error && error.name === 'AbortError' ? 'jupiter_exit_timeout' : 'jupiter_exit_error', startedAt);
  } finally { clearTimeout(timeout); }
}

function emptyProbe(sol: number, status: string): Probe {
  return { sol, status, router: null, mode: null, priceImpact: null, inUsd: null, outUsd: null,
    outAmount: null, thresholdOutUsd: null, transactionBuilt: false, simulationOk: false,
    simulationError: null, unitsConsumed: null, fees: null, slippageBps: executionSettings.slippageBps };
}
function toPublicProbe(probe: Probe) {
  return { sol: probe.sol, status: probe.status, router: probe.router, mode: probe.mode,
    priceImpact: probe.priceImpact, outUsd: probe.thresholdOutUsd ?? probe.outUsd,
    transactionBuilt: probe.transactionBuilt, simulationOk: probe.simulationOk };
}
function failedEntry(status: string, startedAt: number, probes: Probe[] = [], selected?: Probe): ExecutableQuote {
  return {
    eligible: false, status, effectiveEntryPrice: null, positionSol: selected?.sol ?? null,
    positionUsd: selected?.inUsd ?? null, quotedOutUsd: selected?.thresholdOutUsd ?? selected?.outUsd ?? null,
    quotedOutAmount: selected?.outAmount ?? null, priceImpact: selected?.priceImpact ?? null,
    slippageBps: selected?.slippageBps ?? executionSettings.slippageBps,
    feeLamports: selected?.fees ?? null, router: selected?.router ?? null,
    quoteTimeMs: Date.now() - startedAt, transactionBuilt: selected?.transactionBuilt ?? false,
    simulationOk: selected?.simulationOk ?? false, simulationError: selected?.simulationError ?? null,
    executionScore: 0, routeStabilityBps: null, requestedPositionSol: executionSettings.positionSol,
    selectedRouter: selected?.router ?? null, selectedMode: selected?.mode ?? null,
    unitsConsumed: selected?.unitsConsumed ?? null, probeSizes: probes.map(toPublicProbe),
  };
}
function failedExit(status: string, startedAt: number): ExecutableExitQuote {
  return { eligible: false, status, proceedsUsd: null, outputSol: null, priceImpact: null,
    feeLamports: null, router: null, quoteTimeMs: Date.now() - startedAt,
    transactionBuilt: false, simulationOk: false, simulationError: null,
    unitsConsumed: null, executionScore: 0, mode: null };
}
