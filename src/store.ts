import { TokenRecord } from './types';
import { cfg } from './config';

// In-memory hot store. Postgres is the durable log; this is the live watchlist.
const tokens = new Map<string, TokenRecord>();

export function addToken(partial: Pick<TokenRecord, 'ca' | 'symbol' | 'name' | 'creator' | 'source'>): TokenRecord | null {
  if (tokens.has(partial.ca)) return null;
  if (tokens.size >= cfg().limits.max_tracked_tokens) evictOldest();
  const t: TokenRecord = {
    ...partial,
    firstSeen: Date.now(),
    priceUsd: 0, liquidityUsd: 0, mcapUsd: 0, vol5m: 0, buys5m: 0, sells5m: 0, priceChange5m: 0,
    pairAddress: null,
    gated: null, gateFailReason: null,
    score: 0, peakScore: 0, firstScorePrice: null,
    subs: { freshness: 0, liquidity: 0, buyPressure: 0, holderGrowth: 0 },
    uniqueBuyerSamples: [],
    state: 'PENDING', stateChangedAt: Date.now(), lastAlertScore: 0,
  };
  tokens.set(t.ca, t);
  return t;
}

export const getToken = (ca: string) => tokens.get(ca);
export const allTokens = () => [...tokens.values()];
export const activeTokens = () =>
  allTokens().filter(t => t.gated === true && t.state !== 'DEAD');
export const pendingGate = () => allTokens().filter(t => t.gated === null);
export function removeToken(ca: string) { tokens.delete(ca); }

function evictOldest() {
  let oldest: TokenRecord | null = null;
  for (const t of tokens.values()) if (!oldest || t.firstSeen < oldest.firstSeen) oldest = t;
  if (oldest) tokens.delete(oldest.ca);
}
