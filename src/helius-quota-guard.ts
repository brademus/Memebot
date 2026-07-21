// Process-wide Helius billing guard. Helius returns HTTP 429 with "max usage reached"
// when account credits are exhausted. Retrying that condition every few minutes cannot
// recover and only creates noise, latency, and more failed work. After the first hard
// quota response, this guard blocks external Helius traffic until the process restarts.
// Add credits first, then restart Railway to clear the latch deliberately.

const rawFetch = globalThis.fetch.bind(globalThis);
let hardQuotaBlocked = false;
let hardQuotaBlockedAt: number | null = null;
let hardQuotaMessage: string | null = null;
let heliusNetworkRequests = 0;
let locallyBlockedRequests = 0;

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function isHeliusUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'api.helius.xyz'
      || host.endsWith('.helius-rpc.com')
      || host === 'mainnet.helius-rpc.com';
  } catch {
    return /helius\.xyz|helius-rpc\.com/i.test(url);
  }
}

export function isHeliusHardQuotaMessage(status: number, text: string): boolean {
  return status === 429
    && /max usage reached|credits? (?:exhausted|depleted)|out of credits/i.test(text);
}

function localBlockedResponse(): Response {
  return new Response(JSON.stringify({
    error: 'max usage reached (blocked locally until Railway restart after credits are restored)',
  }), {
    status: 429,
    headers: {
      'content-type': 'application/json',
      'retry-after': '300',
      'x-memebot-helius-quota-blocked': 'true',
    },
  });
}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = requestUrl(input);
  if (!isHeliusUrl(url)) return rawFetch(input as any, init);

  if (hardQuotaBlocked) {
    locallyBlockedRequests++;
    return localBlockedResponse();
  }

  heliusNetworkRequests++;
  const response = await rawFetch(input as any, init);
  if (response.status === 429) {
    const text = await response.clone().text().catch(() => '');
    if (isHeliusHardQuotaMessage(response.status, text)) {
      hardQuotaBlocked = true;
      hardQuotaBlockedAt = Date.now();
      hardQuotaMessage = text.slice(0, 500) || 'max usage reached';
      console.error('[helius-quota-guard] account credits exhausted; external Helius calls paused until Railway restart');
    }
  }
  return response;
}) as typeof fetch;

export function heliusQuotaGuardDiag() {
  return {
    hardQuotaBlocked,
    hardQuotaBlockedAt: hardQuotaBlockedAt ? new Date(hardQuotaBlockedAt).toISOString() : null,
    hardQuotaMessage,
    heliusNetworkRequests,
    locallyBlockedRequests,
    recovery: hardQuotaBlocked ? 'restore Helius credits, then restart Railway' : null,
  };
}

(globalThis as any).__heliusQuotaGuardDiag = heliusQuotaGuardDiag;
