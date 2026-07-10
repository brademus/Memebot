// Sellability check: ask Jupiter for a quote selling a small amount of the token into SOL.
// If no route exists, treat as honeypot / untradeable.
const SOL = 'So11111111111111111111111111111111111111112';

export async function canSell(ca: string): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    // 1,000,000 raw units — pump.fun tokens are 6 decimals, so this is 1 token; existence of a route is what matters
    // lite-api is Jupiter's current free-tier quote endpoint (quote-api.jup.ag is dead)
    const url = `https://lite-api.jup.ag/swap/v1/quote?inputMint=${ca}&outputMint=${SOL}&amount=1000000&slippageBps=500`;
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return false;
    const q: any = await res.json();
    return !!(q.outAmount && parseInt(q.outAmount) > 0 && !q.error);
  } catch { return false; }   // timeout or network -> treat as unsellable (fail-safe: better to skip than buy a honeypot)
  finally { clearTimeout(timer); }
}
