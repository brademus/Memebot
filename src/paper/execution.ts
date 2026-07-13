import { cfg } from '../config';
import { TokenRecord } from '../types';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const paper = cfg().paper;

export const executionSettings = {
  requireQuote: paper.require_jupiter_quote,
  targetMultiple: paper.target_multiple,
  stopMultiple: paper.stop_multiple,
  maxHoldHours: paper.max_hold_hours,
  positionSol: paper.position_sol,
  maxLiquidityPct: paper.max_liquidity_pct,
  minPositionUsd: paper.min_position_usd,
  slippageBps: Math.round(paper.slippage_bps),
  maxPriceImpact: paper.max_price_impact_pct,
  quoteTimeoutMs: Math.round(paper.quote_timeout_ms),
  minForwardSamples: Math.round(paper.min_forward_samples_per_lane),
};

export interface ExecutableQuote {
  eligible: boolean;
  status: string;
  effectiveEntryPrice: number | null;
  positionSol: number | null;
  positionUsd: number | null;
  quotedOutUsd: number | null;
  quotedOutAmount: string | null;
  priceImpact: number | null;
  slippageBps: number;
  feeLamports: number | null;
  router: string | null;
  quoteTimeMs: number;
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
}

function failed(status: string, startedAt: number, extras: Partial<ExecutableQuote> = {}): ExecutableQuote {
  return {
    eligible: false, status, effectiveEntryPrice: null, positionSol: null,
    positionUsd: null, quotedOutUsd: null, quotedOutAmount: null,
    priceImpact: null, slippageBps: executionSettings.slippageBps,
    feeLamports: null, router: null, quoteTimeMs: Date.now() - startedAt,
    ...extras,
  };
}

function failedExit(status: string, startedAt: number, extras: Partial<ExecutableExitQuote> = {}): ExecutableExitQuote {
  return {
    eligible: false, status, proceedsUsd: null, outputSol: null,
    priceImpact: null, feeLamports: null, router: null,
    quoteTimeMs: Date.now() - startedAt, ...extras,
  };
}

async function requestOrder(inputMint: string, outputMint: string, amount: string, apiKey: string, signal: AbortSignal) {
  const params = new URLSearchParams({
    inputMint, outputMint, amount, swapMode: 'ExactIn',
    slippageBps: String(executionSettings.slippageBps),
  });
  const response = await fetch(`https://api.jup.ag/swap/v2/order?${params}`, {
    headers: { 'x-api-key': apiKey }, signal,
  });
  const data: any = await response.json().catch(() => ({}));
  return { response, data };
}

function feeLamports(data: any): number {
  return [data.signatureFeeLamports, data.prioritizationFeeLamports, data.rentFeeLamports]
    .reduce((sum, value) => sum + Math.max(0, Number(value) || 0), 0);
}

function thresholdRatio(data: any): number {
  const outAmount = Number(data.outAmount);
  const threshold = Number(data.otherAmountThreshold);
  return Number.isFinite(threshold) && threshold > 0 && Number.isFinite(outAmount) && outAmount > 0
    ? Math.min(1, threshold / outAmount)
    : Math.max(0.01, 1 - executionSettings.slippageBps / 10_000);
}

export async function quoteExecutableEntry(t: TokenRecord, markPrice: number): Promise<ExecutableQuote> {
  const startedAt = Date.now();
  const apiKey = process.env.JUPITER_API_KEY || '';
  if (!apiKey) return failed('jupiter_api_key_missing', startedAt);
  if (!t.ca || !markPrice || markPrice <= 0) return failed('invalid_mark', startedAt);

  const maxPositionUsd = t.liquidityUsd > 0 ? t.liquidityUsd * executionSettings.maxLiquidityPct : Number.POSITIVE_INFINITY;
  if (maxPositionUsd < executionSettings.minPositionUsd)
    return failed('position_below_minimum', startedAt, { positionUsd: maxPositionUsd });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), executionSettings.quoteTimeoutMs);
  try {
    let amount = Math.max(1, Math.floor(executionSettings.positionSol * 1_000_000_000));
    let { response, data } = await requestOrder(SOL_MINT, t.ca, String(amount), apiKey, controller.signal);
    if (!response.ok) return failed(`jupiter_http_${response.status}`, startedAt);
    if (data?.error || data?.errorMessage || !data?.outAmount) return failed('jupiter_no_route', startedAt, { router: data?.router || null });

    let inUsd = Number(data.inUsdValue);
    if (!Number.isFinite(inUsd) || inUsd <= 0) return failed('jupiter_invalid_quote', startedAt);
    if (inUsd > maxPositionUsd * 1.01) {
      amount = Math.max(1, Math.floor(amount * maxPositionUsd / inUsd));
      ({ response, data } = await requestOrder(SOL_MINT, t.ca, String(amount), apiKey, controller.signal));
      if (!response.ok) return failed(`jupiter_http_${response.status}`, startedAt);
      if (data?.error || data?.errorMessage || !data?.outAmount)
        return failed('jupiter_no_route_after_size_cap', startedAt, { router: data?.router || null });
      inUsd = Number(data.inUsdValue);
    }

    const positionSol = amount / 1_000_000_000;
    const outUsd = Number(data.outUsdValue);
    const outAmount = String(data.outAmount || '');
    const impact = Math.abs(Number(data.priceImpact ?? data.priceImpactPct ?? 0));
    if (![inUsd, outUsd].every(Number.isFinite) || inUsd <= 0 || outUsd <= 0 || !/^\d+$/.test(outAmount))
      return failed('jupiter_invalid_quote', startedAt);
    if (inUsd < executionSettings.minPositionUsd)
      return failed('position_below_minimum', startedAt, { positionSol, positionUsd: inUsd });

    const minimumOutUsd = outUsd * thresholdRatio(data);
    const fees = feeLamports(data);
    const impliedSolUsd = inUsd / positionSol;
    const totalCostUsd = inUsd + (fees / 1_000_000_000) * impliedSolUsd;
    const effectiveEntryPrice = markPrice * (totalCostUsd / minimumOutUsd);
    const common = {
      positionSol, positionUsd: totalCostUsd, quotedOutUsd: minimumOutUsd,
      quotedOutAmount: outAmount, priceImpact: impact,
      slippageBps: Number(data.slippageBps) || executionSettings.slippageBps,
      feeLamports: fees, router: data.router || null, quoteTimeMs: Date.now() - startedAt,
    };
    if (!Number.isFinite(impact) || impact > executionSettings.maxPriceImpact)
      return failed('price_impact_too_high', startedAt, common);
    if (!Number.isFinite(effectiveEntryPrice) || effectiveEntryPrice <= 0)
      return failed('effective_price_invalid', startedAt, common);
    return { eligible: true, status: 'executable_quote', effectiveEntryPrice, ...common };
  } catch (error) {
    return failed(error instanceof Error && error.name === 'AbortError' ? 'jupiter_timeout' : 'jupiter_error', startedAt);
  } finally { clearTimeout(timeout); }
}

/** Quote liquidation of the exact token amount received at entry. A 3x is counted as
 * executable only when the conservative minimum SOL output, net of fees, clears 3x. */
export async function quoteExecutableExit(tokenMint: string, tokenAmountRaw: string): Promise<ExecutableExitQuote> {
  const startedAt = Date.now();
  const apiKey = process.env.JUPITER_API_KEY || '';
  if (!apiKey) return failedExit('jupiter_api_key_missing', startedAt);
  if (!tokenMint || !/^\d+$/.test(tokenAmountRaw) || tokenAmountRaw === '0') return failedExit('invalid_exit_amount', startedAt);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), executionSettings.quoteTimeoutMs);
  try {
    const { response, data } = await requestOrder(tokenMint, SOL_MINT, tokenAmountRaw, apiKey, controller.signal);
    if (!response.ok) return failedExit(`jupiter_exit_http_${response.status}`, startedAt);
    if (data?.error || data?.errorMessage || !data?.outAmount) return failedExit('jupiter_exit_no_route', startedAt);
    const outUsd = Number(data.outUsdValue);
    const outAmount = Number(data.outAmount);
    const impact = Math.abs(Number(data.priceImpact ?? data.priceImpactPct ?? 0));
    const inUsd = Number(data.inUsdValue);
    if (![outUsd, outAmount, inUsd].every(Number.isFinite) || outUsd <= 0 || outAmount <= 0 || inUsd <= 0)
      return failedExit('jupiter_exit_invalid_quote', startedAt);
    const fees = feeLamports(data);
    const minimumOutUsd = outUsd * thresholdRatio(data);
    const outputSol = outAmount / 1_000_000_000;
    const impliedSolUsd = outUsd / Math.max(outputSol, 1e-12);
    const proceedsUsd = Math.max(0, minimumOutUsd - (fees / 1_000_000_000) * impliedSolUsd);
    const common = { proceedsUsd, outputSol, priceImpact: impact, feeLamports: fees, router: data.router || null, quoteTimeMs: Date.now() - startedAt };
    if (!Number.isFinite(impact) || impact > executionSettings.maxPriceImpact)
      return failedExit('jupiter_exit_price_impact_too_high', startedAt, common);
    return { eligible: true, status: 'executable_exit_quote', ...common };
  } catch (error) {
    return failedExit(error instanceof Error && error.name === 'AbortError' ? 'jupiter_exit_timeout' : 'jupiter_exit_error', startedAt);
  } finally { clearTimeout(timeout); }
}
