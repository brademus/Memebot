// Conservative process-wide Helius guard for the 1,000,000-credit free plan.
// Enhanced API requests are estimated at 100 credits; RPC requests at 1 credit.
// The hard per-process ceiling prevents a runaway background task from consuming
// the monthly allowance overnight. It does not expose or log the API key.

const rawFetch = globalThis.fetch.bind(globalThis);
const MAX_ESTIMATED_CREDITS = 20_000;
let estimatedCredits = 0;
let blockedRequests = 0;

function isHelius(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'api.helius.xyz' || host.endsWith('.helius-rpc.com');
  } catch {
    return /helius\.xyz|helius-rpc\.com/i.test(url);
  }
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function estimatedCost(url: string): number {
  try {
    const parsed = new URL(url);
    return parsed.hostname === 'api.helius.xyz' ? 100 : 1;
  } catch {
    return /api\.helius\.xyz/i.test(url) ? 100 : 1;
  }
}

function blockedResponse(): Response {
  return new Response(JSON.stringify({ error: 'helius free-plan process budget reached' }), {
    status: 429,
    headers: {
      'content-type': 'application/json',
      'retry-after': '3600',
      'x-memebot-helius-budget-blocked': 'true',
    },
  });
}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = requestUrl(input);
  if (!isHelius(url)) return rawFetch(input as any, init);
  const cost = estimatedCost(url);
  if (estimatedCredits + cost > MAX_ESTIMATED_CREDITS) {
    blockedRequests++;
    return blockedResponse();
  }
  estimatedCredits += cost;
  return rawFetch(input as any, init);
}) as typeof fetch;

export function heliusFreeBudgetDiag() {
  return {
    enabled: true,
    maxEstimatedCreditsPerProcess: MAX_ESTIMATED_CREDITS,
    estimatedCreditsUsed: estimatedCredits,
    estimatedCreditsRemaining: Math.max(0, MAX_ESTIMATED_CREDITS - estimatedCredits),
    blockedRequests,
  };
}

(globalThis as any).__heliusFreeBudgetDiag = heliusFreeBudgetDiag;
console.log(`[helius-free-budget] enabled: max ${MAX_ESTIMATED_CREDITS} estimated credits per process`);
