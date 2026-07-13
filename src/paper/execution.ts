import { getSolPrice } from '../ingest/pumpfun';
import { TokenRecord } from '../types';

const SOL_MINT = 'So11111111111111111111111111111111111111112';

function envNumber(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export const executionSettings = {
  targetMultiple: envNumber('PAPER_TARGET_MULTIPLE', 3, 1.1, 20),
  stopMultiple: envNumber('PAPER_STOP_MULTIPLE', 0.5, 0.05, 0.99),
  maxHoldHours: envNumber('PAPER_MAX_HOLD_HOURS', 24, 1, 168),
  positionSol: envNumber('PAPER_POSITION_SOL', 0.1, 0.001, 100),
  maxLiquidityPct: envNumber('PAPER_MAX_LIQUIDITY_PCT', 0.005, 0.0001, 0.05),
  minPositionUsd: envNumber('PAPER_MIN_POSITION_USD', 10, 1, 10000),
  slippageBps: Math.round(envNumber('PAPER_SLIPPAGE_BPS', 150, 1, 5000)),
  maxPriceImpact: envNumber('PAPER_MAX_PRICE_IMPACT', 0.08, 0.001, 1),
  quoteTimeoutMs: Math.round(envNumber('PAPER_QUOTE_TIMEOUT_MS', 4000, 500, 15000)),
  minForwardSamples: Math.round(envNumber('PAPER_MIN_FORWARD_SAMPLES', 100, 20, 10000)),
};

export interface ExecutableQuote {
  eligible: boolean;
  status: string;
  effectiveEntryPrice: number | null;
  positionSol: number | null;
  positionUsd: number | null;
  quotedOutUsd: number | null;
  priceImpact: number | null;
  slippageBps: number;
  feeLamports: number | null;
  router: string | null;
  quoteTimeMs: number;
}

function failed(status: string, startedAt: number, extras: Partial<ExecutableQuote> = {}): ExecutableQuote {
  return {
    eligible: false,
    status,
    effectiveEntryPrice: null,
    positionSol: null,
    positionUsd: null,
    quotedOutUsd: null,
    priceImpact: null,
    slippageBps: executionSettings.slippageBps,
    feeLamports: null,
    router: null,
    quoteTimeMs: Date.now() - startedAt,
    ...extras,
  };
}

// Quote-only use of Jupiter Swap V2. No wallet, private key, transaction signing,
// or execution is involved. The entry price is made conservative by valuing output
// at Jupiter's minimum amount after slippage and adding estimated network fees.
export async function quoteExecutableEntry(t: TokenRecord, markPrice: number): Promise<ExecutableQuote> {
  const startedAt = Date.now();
  const apiKey = process.env.JUPITER_API_KEY || '';
  if (!apiKey) return failed('jupiter_api_key_missing', startedAt);
  if (!t.ca || !markPrice || markPrice <= 0) return failed('invalid_mark', startedAt);

  const solUsd = getSolPrice();
  if (!Number.isFinite(solUsd) || solUsd <= 0) return failed('sol_price_unavailable', startedAt);

  // Do not model a position large enough to materially consume the displayed pool.
  const liquidityCappedSol = t.liquidityUsd > 0
    ? (t.liquidityUsd * executionSettings.maxLiquidityPct) / solUsd
    : executionSettings.positionSol;
  const positionSol = Math.min(executionSettings.positionSol, liquidityCappedSol);
  const estimatedPositionUsd = positionSol * solUsd;
  if (estimatedPositionUsd < executionSettings.minPositionUsd) {
    return failed('position_below_minimum', startedAt, { positionSol, positionUsd: estimatedPositionUsd });
  }

  const amount = Math.max(1, Math.floor(positionSol * 1_000_000_000));
  const params = new URLSearchParams({
    inputMint: SOL_MINT,
    outputMint: t.ca,
    amount: String(amount),
    swapMode: 'ExactIn',
    slippageBps: String(executionSettings.slippageBps),
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), executionSettings.quoteTimeoutMs);
  try {
    const response = await fetch(`https://api.jup.ag/swap/v2/order?${params}`, {
      headers: { 'x-api-key': apiKey },
      signal: controller.signal,
    });
    const data: any = await response.json().catch(() => ({}));
    if (!response.ok) return failed(`jupiter_http_${response.status}`, startedAt);
    if (data?.error || data?.errorMessage || !data?.outAmount) {
      return failed('jupiter_no_route', startedAt, { router: data?.router || null });
    }

    const inUsd = Number(data.inUsdValue);
    const outUsd = Number(data.outUsdValue);
    const outAmount = Number(data.outAmount);
    const threshold = Number(data.otherAmountThreshold);
    const impact = Math.abs(Number(data.priceImpact ?? data.priceImpactPct ?? 0));
    if (![inUsd, outUsd, outAmount].every(Number.isFinite) || inUsd <= 0 || outUsd <= 0 || outAmount <= 0) {
      return failed('jupiter_invalid_quote', startedAt);
    }

    const thresholdRatio = Number.isFinite(threshold) && threshold > 0
      ? Math.min(1, threshold / outAmount)
      : Math.max(0.01, 1 - executionSettings.slippageBps / 10_000);
    const minimumOutUsd = outUsd * thresholdRatio;
    const feeLamports = [
      data.signatureFeeLamports,
      data.prioritizationFeeLamports,
      data.rentFeeLamports,
    ].reduce((sum, value) => sum + Math.max(0, Number(value) || 0), 0);
    const totalCostUsd = inUsd + (feeLamports / 1_000_000_000) * solUsd;
    const effectiveEntryPrice = markPrice * (totalCostUsd / minimumOutUsd);
    const common = {
      positionSol,
      positionUsd: totalCostUsd,
      quotedOutUsd: minimumOutUsd,
      priceImpact: impact,
      slippageBps: Number(data.slippageBps) || executionSettings.slippageBps,
      feeLamports,
      router: data.router || null,
      quoteTimeMs: Date.now() - startedAt,
    };

    if (!Number.isFinite(impact) || impact > executionSettings.maxPriceImpact) {
      return failed('price_impact_too_high', startedAt, common);
    }
    if (!Number.isFinite(effectiveEntryPrice) || effectiveEntryPrice <= 0) {
      return failed('effective_price_invalid', startedAt, common);
    }

    return {
      eligible: true,
      status: 'executable_quote',
      effectiveEntryPrice,
      ...common,
    };
  } catch (error) {
    return failed(error instanceof Error && error.name === 'AbortError' ? 'jupiter_timeout' : 'jupiter_error', startedAt);
  } finally {
    clearTimeout(timeout);
  }
}
