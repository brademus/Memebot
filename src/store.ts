import { TokenRecord } from './types';
import { cfg } from './config';

const tokens = new Map<string, TokenRecord>();

export function addToken(partial: Pick<TokenRecord, 'ca' | 'symbol' | 'name' | 'creator' | 'source'>): TokenRecord | null {
  if (tokens.has(partial.ca)) return null;
  if (tokens.size >= cfg().limits.max_tracked_tokens) evictOldest();
  const t: TokenRecord = {
    ...partial,
    firstSeen: Date.now(), marketCreatedAt: null, marketSamples: [],
    deployerRep: null, gradAt: null, gradPeak: 0, gradTrough: 0, fillMinutes: null, secondWaveAt: null,
    priceUsd: 0, liquidityUsd: 0, mcapUsd: 0, vol5m: 0, buys5m: 0, sells5m: 0, priceChange5m: 0,
    pairAddress: null, curveSol: 0, curveSamples: [], uniqueBuyers: [], devBuyPct: 0,
    totalBuys: 0, totalSells: 0, recentTrades: [], earlyBuyers: [], earlyExited: [], peakCurveSol: 0,
    socials: { x: false, tg: false, web: false, fetched: false, tgMembers: null },
    description: null, aiConviction: null, boostAmount: 0, tgSamples: [], tgGrowthPerMin: 0,
    playType: null, laddersFired: [], triggeredAt: null, triggerPrice: null, insiderKilled: false, convictionAt: null, dex: null, dexId: null,
    gated: null, gateFailReason: null, bundle: null, entityGraph: null, modelDecision: null, modelDecisionAt: null,
    aiNote: null, smartHits: [], ai: null,
    score: 0, peakScore: 0, firstScorePrice: null,
    subs: { freshness: 0, liquidity: 0, buyPressure: 0, holderGrowth: 0, smartMoney: 0 },
    uniqueBuyerSamples: [],
    state: 'PENDING', stateChangedAt: Date.now(), lastAlertScore: 0,
  };
  tokens.set(t.ca, t);
  return t;
}

export const hydration = { restored: 0, at: null as string | null };

export function hydrateToken(base: { ca: string; symbol: string; name: string; creator: string | null; source: any; firstSeenMs: number; earlyBuyers: string[] }, runtime: any): boolean {
  if (tokens.has(base.ca)) return false;
  if (tokens.size >= cfg().limits.max_tracked_tokens) return false;
  const fresh = addToken({ ca: base.ca, symbol: base.symbol, name: base.name, creator: base.creator, source: base.source });
  if (!fresh) return false;
  fresh.firstSeen = base.firstSeenMs;
  fresh.earlyBuyers = base.earlyBuyers || [];
  Object.assign(fresh, runtime || {});
  fresh.marketSamples = Array.isArray(runtime?.marketSamples) ? runtime.marketSamples : [];
  fresh.marketCreatedAt = Number(runtime?.marketCreatedAt) || null;
  fresh.entityGraph = runtime?.entityGraph || fresh.entityGraph;
  fresh.modelDecision = runtime?.modelDecision || null;
  fresh.modelDecisionAt = runtime?.modelDecisionAt || null;
  return true;
}

export const getToken = (ca: string) => tokens.get(ca);
export const allTokens = () => [...tokens.values()];
export const activeTokens = () => allTokens().filter(t => t.gated === true && t.state !== 'DEAD');
export const pendingGate = () => allTokens().filter(t => t.gated === null);
const onRemove: ((ca: string) => void)[] = [];
export function onTokenRemove(fn: (ca: string) => void) { onRemove.push(fn); }
function fireRemove(ca: string) { for (const fn of onRemove) try { fn(ca); } catch {} }
export function removeToken(ca: string) { if (tokens.delete(ca)) fireRemove(ca); }

function evictOldest() {
  const pick = (pred: (t: TokenRecord) => boolean): TokenRecord | null => {
    let oldest: TokenRecord | null = null;
    for (const t of tokens.values()) if (pred(t) && (!oldest || t.firstSeen < oldest.firstSeen)) oldest = t;
    return oldest;
  };
  const victim = pick(t => t.gated === false) || pick(t => t.gated === null) || pick(() => true);
  if (victim) { tokens.delete(victim.ca); fireRemove(victim.ca); }
}

export interface ScanEntry { ca: string; symbol: string; verdict: 'PASS' | 'KILL'; reason: string | null; at: number }
const scans: ScanEntry[] = [];
export function recordScan(e: ScanEntry) {
  scans.unshift(e);
  if (scans.length > 200) scans.pop();
}
export const recentScans = () => scans;
