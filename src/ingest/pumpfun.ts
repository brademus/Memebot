import { createHash } from 'node:crypto';
import WebSocket from 'ws';
import { addToken, getToken, allTokens, recordScan } from '../store';
import { bumpDeployer, upsertToken } from '../db';
import { prefilter } from '../gates/prefilter';
import { env } from '../config';
import { fetchSocials } from './metadata';
import { recordTradeEvent } from '../market/trade-events';
import { TradeEvent } from '../types';

let SOL_USD = 150;
export function setSolPrice(price: number) { if (price > 0) SOL_USD = price; }
export const getSolPrice = () => SOL_USD;

const TRADE_STREAM_STALE_MS = 4 * 60_000;
const rawPumpPortalApiKey = env.PUMPPORTAL_API_KEY || '';
const pumpPortalApiKey = rawPumpPortalApiKey.trim();
const tradeStreamConfigured = !!pumpPortalApiKey;
const keyFingerprint = tradeStreamConfigured
  ? createHash('sha256').update(pumpPortalApiKey).digest('hex').slice(0, 10)
  : null;
const keyHasOuterQuotes = pumpPortalApiKey.length >= 2
  && ((pumpPortalApiKey.startsWith('"') && pumpPortalApiKey.endsWith('"'))
    || (pumpPortalApiKey.startsWith("'") && pumpPortalApiKey.endsWith("'")));

let ws: WebSocket | null = null;
let backoff = 1000;
let connectionAttempts = 0;
let successfulConnections = 0;
let reconnects = 0;
let lastSocketOpenAt: number | null = null;
let lastMessageAt: number | null = null;
let lastTradeAt: number | null = null;
let lastControlAt: number | null = null;
let lastControlMessage: string | null = null;
let lastProtocolErrorAt: number | null = null;
let lastProtocolError: string | null = null;
let lastParseErrorAt: number | null = null;
let lastParseError: string | null = null;
let lastSocketErrorAt: number | null = null;
let lastSocketError: string | null = null;
let lastCloseAt: number | null = null;
let lastCloseCode: number | null = null;
let lastCloseReason: string | null = null;
let totalMessages = 0;
let createMessages = 0;
let migrationMessages = 0;
let tradeMessages = 0;
let appliedTradeMessages = 0;
let unknownTradeTokenMessages = 0;
let walletTaggedTrades = 0;
let controlMessages = 0;
let unknownMessages = 0;
let parseErrors = 0;
let subscriptionSendErrors = 0;
let newTokenSubscriptions = 0;
let migrationSubscriptions = 0;
let tokenTradeSubscriptionCommands = 0;
let tokenTradeKeysRequested = 0;
let unsubscribeCommands = 0;
let lastSubscriptionAt: number | null = null;
let lastSubscriptionError: string | null = null;

export type PumpPortalMessageKind = 'create' | 'trade' | 'migration' | 'control' | 'unknown';

export function classifyPumpPortalMessage(msg: unknown): PumpPortalMessageKind {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return 'unknown';
  const value = msg as Record<string, unknown>;
  const txType = String(value.txType || '').toLowerCase();
  if (value.mint && txType === 'create') return 'create';
  if (value.mint && (txType === 'buy' || txType === 'sell')) return 'trade';
  if (value.mint && (txType === 'migrate' || txType === 'migration')) return 'migration';
  if ('message' in value || 'error' in value || 'errors' in value || 'status' in value
    || 'success' in value || 'result' in value) return 'control';
  return 'unknown';
}

function stringifySafe(value: unknown): string {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function redactPumpPortalText(value: unknown, apiKey = pumpPortalApiKey): string {
  let text = stringifySafe(value);
  if (apiKey) text = text.split(apiKey).join('[REDACTED_API_KEY]');
  text = text.replace(/([?&]api-key=)[^&\s"']+/gi, '$1[REDACTED_API_KEY]');
  return text.slice(0, 800);
}

export function pumpPortalRejection(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const msg = value as Record<string, unknown>;
  const status = String(msg.status || '').toLowerCase();
  const structuredFailure = Boolean(msg.error || msg.errors || msg.success === false
    || ['error', 'failed', 'failure', 'rejected', 'unauthorized', 'forbidden'].includes(status));
  const text = redactPumpPortalText(msg);
  const failureLanguage = /\b(invalid|insufficient|unauthori[sz]ed|forbidden|banned|blocked|rejected|failed|failure|error|rate[ -]?limit(?:ed)?|too many|payment required|funds? required|balance too low|not enough)\b/i.test(text);
  return structuredFailure || failureLanguage ? text : null;
}

export function tradeStreamModeFromHealth(
  configured: boolean,
  lastTradeEventAt: number | null,
  now = Date.now(),
  staleMs = TRADE_STREAM_STALE_MS,
): 'full' | 'lite' {
  if (!configured || lastTradeEventAt === null) return 'lite';
  return now - lastTradeEventAt <= staleMs ? 'full' : 'lite';
}

// A configured key is not proof that token-trade events are actually arriving. The
// scoring pipeline must use strict wallet-level evidence only while that feed is live.
// When the paid feed is silent or stale, aggregate Dexscreener evidence is used instead
// of permanently deadlocking every conviction at the final entry gate.
export const getStreamMode = () => tradeStreamModeFromHealth(tradeStreamConfigured, lastTradeAt);

const iso = (value: number | null) => value ? new Date(value).toISOString() : null;

export const pumpfunStreamDiag = () => {
  const now = Date.now();
  const effectiveMode = getStreamMode();
  const staleForSeconds = lastTradeAt === null ? null : Math.max(0, Math.round((now - lastTradeAt) / 1000));
  const connected = ws?.readyState === WebSocket.OPEN;
  return {
    configured: tradeStreamConfigured,
    connected,
    effectiveMode,
    key: {
      fingerprint: keyFingerprint,
      normalizedLength: pumpPortalApiKey.length,
      hadSurroundingWhitespace: rawPumpPortalApiKey !== pumpPortalApiKey,
      hasOuterQuotes: keyHasOuterQuotes,
      formatWarning: keyHasOuterQuotes
        ? 'Remove quote characters from PUMPPORTAL_API_KEY in Railway.'
        : rawPumpPortalApiKey !== pumpPortalApiKey
          ? 'Leading or trailing whitespace was removed at runtime; clean the Railway variable.'
          : null,
    },
    connection: {
      readyState: ws?.readyState ?? null,
      attempts: connectionAttempts,
      successfulConnections,
      reconnects,
      lastSocketOpenAt: iso(lastSocketOpenAt),
      lastMessageAt: iso(lastMessageAt),
      lastSocketErrorAt: iso(lastSocketErrorAt),
      lastSocketError,
      lastCloseAt: iso(lastCloseAt),
      lastCloseCode,
      lastCloseReason,
      reconnectBackoffMs: backoff,
    },
    messages: {
      total: totalMessages,
      creates: createMessages,
      tradesReceived: tradeMessages,
      tradesApplied: appliedTradeMessages,
      tradesForUnknownTokens: unknownTradeTokenMessages,
      migrations: migrationMessages,
      controls: controlMessages,
      unknown: unknownMessages,
      parseErrors,
      walletTaggedTrades,
      walletCoverage: tradeMessages ? +(walletTaggedTrades / tradeMessages).toFixed(3) : 0,
      lastTradeAt: iso(lastTradeAt),
      lastControlAt: iso(lastControlAt),
      lastControlMessage,
      lastProtocolErrorAt: iso(lastProtocolErrorAt),
      lastProtocolError,
      lastParseErrorAt: iso(lastParseErrorAt),
      lastParseError,
    },
    subscriptions: {
      newTokenCommands: newTokenSubscriptions,
      migrationCommands: migrationSubscriptions,
      tokenTradeCommands: tokenTradeSubscriptionCommands,
      tokenTradeKeysRequested,
      unsubscribeCommands,
      sendErrors: subscriptionSendErrors,
      lastSubscriptionAt: iso(lastSubscriptionAt),
      lastSubscriptionError,
    },
    // Retain the original top-level fields so existing reports and dashboards remain compatible.
    tradeMessages,
    appliedTradeMessages,
    walletTaggedTrades,
    walletCoverage: tradeMessages ? +(walletTaggedTrades / tradeMessages).toFixed(3) : 0,
    lastSocketOpenAt: iso(lastSocketOpenAt),
    lastTradeAt: iso(lastTradeAt),
    staleForSeconds,
    staleAfterSeconds: Math.round(TRADE_STREAM_STALE_MS / 1000),
    reason: !tradeStreamConfigured
      ? 'api_key_missing'
      : keyHasOuterQuotes
        ? 'api_key_has_outer_quotes'
        : lastProtocolError && lastProtocolErrorAt && (!lastTradeAt || lastProtocolErrorAt >= lastTradeAt)
          ? 'pumpportal_rejected_or_errored'
          : !connected
            ? 'socket_not_open'
            : lastTradeAt === null
              ? 'no_token_trade_events_received'
              : effectiveMode === 'lite'
                ? 'token_trade_stream_stale'
                : 'healthy',
  };
};

function normalizeSol(value: unknown): number | null {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return amount > 1_000_000 ? amount / 1_000_000_000 : amount;
}
function normalizeToken(value: unknown): number | null {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

function seedCurve(t: any, msg: any) {
  const now = Date.now();
  const solInCurve = Number(msg.vSolInBondingCurve || 0);
  const tokensInCurve = Number(msg.vTokensInBondingCurve || 0);
  const mcapSol = Number(msg.marketCapSol || 0);
  t.curveSol = solInCurve;
  t.liquidityUsd = solInCurve * SOL_USD;
  t.mcapUsd = mcapSol * SOL_USD;
  if (solInCurve > 0 && tokensInCurve > 0) t.priceUsd = (solInCurve / tokensInCurve) * SOL_USD;
  if (t.priceUsd > 0) t.marketUpdatedAt = now;
  t.dex = 'pumpfun';
  t.dexId = 'pumpfun';
  if (msg.initialBuy || msg.solAmount) t.buys5m = 1;
  if (msg.initialBuy) t.devBuyPct = Math.min(100, (Number(msg.initialBuy) / 1e9) * 100);
  t.curveSamples = [{ sol: solInCurve, at: now }];
}

function applyCurveTrade(msg: any): boolean {
  const t = getToken(msg.mint);
  if (!t) return false;
  const now = Date.now();

  if (msg.vSolInBondingCurve) {
    t.curveSol = Number(msg.vSolInBondingCurve);
    t.peakCurveSol = Math.max(t.peakCurveSol, t.curveSol);
    t.liquidityUsd = t.curveSol * SOL_USD;
  }
  if (msg.marketCapSol) t.mcapUsd = Number(msg.marketCapSol) * SOL_USD;
  if (msg.vSolInBondingCurve && msg.vTokensInBondingCurve) {
    t.priceUsd = (Number(msg.vSolInBondingCurve) / Number(msg.vTokensInBondingCurve)) * SOL_USD;
    t.marketUpdatedAt = now;
  }

  const wallet = String(msg.traderPublicKey || msg.user || msg.trader || '') || null;
  const buy = msg.txType === 'buy';
  const event: TradeEvent = {
    at: now,
    buy,
    wallet,
    solAmount: normalizeSol(msg.solAmount ?? msg.sol_amount),
    tokenAmount: normalizeToken(msg.tokenAmount ?? msg.token_amount),
    signature: String(msg.signature || msg.txSignature || msg.tx || '') || null,
    slot: Number.isFinite(Number(msg.slot)) ? Number(msg.slot) : null,
    priceUsd: t.priceUsd || null,
    curveSol: t.curveSol || null,
  };

  if (buy) {
    t.totalBuys++;
    if (wallet && !t.uniqueBuyers.includes(wallet) && t.uniqueBuyers.length < 800) t.uniqueBuyers.push(wallet);
    if (wallet && t.earlyBuyers.length < 25 && !t.earlyBuyers.includes(wallet)) t.earlyBuyers.push(wallet);
  } else {
    t.totalSells++;
    if (wallet && t.earlyBuyers.includes(wallet) && !t.earlyExited.includes(wallet)) t.earlyExited.push(wallet);
  }
  t.recentTrades.push(event);
  recordTradeEvent(t.ca, event);

  const cutoff = now - 5 * 60_000;
  while (t.recentTrades.length && t.recentTrades[0].at < cutoff) t.recentTrades.shift();
  if (t.dex === 'pumpfun') {
    t.buys5m = t.recentTrades.filter(trade => trade.buy).length;
    t.sells5m = t.recentTrades.length - t.buys5m;
  }
  if (buy) {
    t.uniqueBuyerSamples.push(t.uniqueBuyers.length);
    if (t.uniqueBuyerSamples.length > 12) t.uniqueBuyerSamples.shift();
  }
  t.curveSamples.push({ sol: t.curveSol, at: now });
  if (t.curveSamples.length > 120) t.curveSamples.shift();
  return true;
}

const WS_URL = () => 'wss://pumpportal.fun/api/data' + (tradeStreamConfigured ? `?api-key=${encodeURIComponent(pumpPortalApiKey)}` : '');

function sendSubscription(method: string, keys?: string[]): boolean {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  try {
    ws.send(JSON.stringify(keys ? { method, keys } : { method }));
    lastSubscriptionAt = Date.now();
    lastSubscriptionError = null;
    if (method === 'subscribeNewToken') newTokenSubscriptions++;
    else if (method === 'subscribeMigration') migrationSubscriptions++;
    else if (method === 'subscribeTokenTrade') {
      tokenTradeSubscriptionCommands++;
      tokenTradeKeysRequested += keys?.length || 0;
    } else if (method === 'unsubscribeTokenTrade') unsubscribeCommands++;
    return true;
  } catch (error) {
    subscriptionSendErrors++;
    lastSubscriptionError = redactPumpPortalText((error as Error).message);
    console.error(`[pumpfun] subscription send failed method=${method}:`, lastSubscriptionError);
    return false;
  }
}

export function startPumpfunMonitor(onNew: (ca: string) => void) { connect(onNew); }

function connect(onNew: (ca: string) => void) {
  connectionAttempts++;
  ws = new WebSocket(WS_URL());
  ws.on('open', () => {
    backoff = 1000;
    successfulConnections++;
    lastSocketOpenAt = Date.now();
    lastSocketError = null;
    sendSubscription('subscribeNewToken');
    sendSubscription('subscribeMigration');
    if (tradeStreamConfigured) {
      const live = allTokens().filter(t => t.gated !== false && t.dex === 'pumpfun' && t.state !== 'DEAD').map(t => t.ca);
      for (let index = 0; index < live.length; index += 50)
        sendSubscription('subscribeTokenTrade', live.slice(index, index + 50));
      console.log(`[pumpfun] connected — paid trade feed configured (key ${keyFingerprint}), resubscribed ${live.length} live token streams`);
    } else console.log('[pumpfun] connected, subscribed to new tokens + migrations');
  });

  ws.on('message', (raw: WebSocket.RawData) => {
    const receivedAt = Date.now();
    lastMessageAt = receivedAt;
    totalMessages++;
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch (error) {
      parseErrors++;
      lastParseErrorAt = receivedAt;
      lastParseError = `${(error as Error).message}; payload=${redactPumpPortalText(raw.toString())}`;
      console.error('[pumpfun] unparseable websocket message:', lastParseError);
      return;
    }

    const kind = classifyPumpPortalMessage(msg);
    if (kind === 'create') {
      createMessages++;
      const fail = prefilter(msg);
      const t = addToken({ ca: msg.mint, symbol: msg.symbol || '?', name: msg.name || '?', creator: msg.traderPublicKey || null, source: 'pumpfun' });
      if (t && fail) {
        t.gated = false;
        t.gateFailReason = fail;
        seedCurve(t, msg);
        if (t.firstScorePrice === null && t.priceUsd > 0) t.firstScorePrice = t.priceUsd;
        recordScan({ ca: t.ca, symbol: t.symbol, verdict: 'KILL', reason: fail, at: Date.now() });
        upsertToken(t).catch(() => {});
      } else if (t) {
        seedCurve(t, msg);
        fetchSocials(t, msg.uri);
        if (t.creator) bumpDeployer(t.creator);
        if (tradeStreamConfigured) sendSubscription('subscribeTokenTrade', [msg.mint]);
        onNew(t.ca);
      }
      return;
    }

    if (kind === 'trade') {
      const previousMode = getStreamMode();
      tradeMessages++;
      lastTradeAt = receivedAt;
      const wallet = String(msg.traderPublicKey || msg.user || msg.trader || '') || null;
      if (wallet) walletTaggedTrades++;
      if (applyCurveTrade(msg)) appliedTradeMessages++;
      else unknownTradeTokenMessages++;
      if (previousMode === 'lite') console.log('[pumpfun] token-trade stream active — strict wallet evidence restored');
      return;
    }

    if (kind === 'migration') {
      migrationMessages++;
      const t = getToken(msg.mint);
      if (t) {
        t.dex = 'pumpswap'; t.dexId = 'pumpswap'; t.playType = 'GRADUATION';
        t.gradAt = Date.now(); t.gradPeak = t.priceUsd || 0; t.gradTrough = t.priceUsd || 0;
        if (t.firstSeen) t.fillMinutes = Math.round((Date.now() - t.firstSeen) / 60_000);
        console.log(`[pumpfun] 🎓 GRADUATED $${t.symbol} -> PumpSwap (fill ${t.fillMinutes}m)`);
      }
      return;
    }

    if (kind === 'control') {
      controlMessages++;
      lastControlAt = receivedAt;
      lastControlMessage = redactPumpPortalText(msg);
      const rejection = pumpPortalRejection(msg);
      if (rejection) {
        lastProtocolErrorAt = receivedAt;
        lastProtocolError = rejection;
        console.error('[pumpfun] PumpPortal rejected or errored:', rejection);
      } else {
        console.log('[pumpfun] PumpPortal control:', lastControlMessage);
      }
      return;
    }

    unknownMessages++;
    lastControlAt = receivedAt;
    lastControlMessage = redactPumpPortalText(msg);
    console.log('[pumpfun] unrecognized PumpPortal message:', lastControlMessage);
  });
  ws.on('close', (code: number, reason: Buffer) => {
    lastCloseAt = Date.now();
    lastCloseCode = code;
    lastCloseReason = redactPumpPortalText(reason.toString() || '(no reason)');
    console.error(`[pumpfun] websocket closed code=${code} reason=${lastCloseReason}`);
    reconnect(onNew);
  });
  ws.on('error', error => {
    lastSocketErrorAt = Date.now();
    lastSocketError = redactPumpPortalText(error.message);
    console.error('[pumpfun] ws error:', lastSocketError);
    ws?.close();
  });
}

export function unsubscribeToken(ca: string) { sendSubscription('unsubscribeTokenTrade', [ca]); }
export function resubscribeAll() {
  if (!tradeStreamConfigured || !ws || ws.readyState !== WebSocket.OPEN) return 0;
  const live = allTokens().filter(t => t.gated !== false && t.dex === 'pumpfun' && t.state !== 'DEAD').map(t => t.ca);
  for (let index = 0; index < live.length; index += 50)
    sendSubscription('subscribeTokenTrade', live.slice(index, index + 50));
  return live.length;
}
export function startSubscriptionReconciler() {
  const timer = setInterval(() => {
    if (!tradeStreamConfigured || !ws || ws.readyState !== WebSocket.OPEN) return;
    const now = Date.now();
    const stale = allTokens().filter(t => t.gated !== false && t.dex === 'pumpfun' && t.state !== 'DEAD'
      && (!t.recentTrades.length || now - t.recentTrades[t.recentTrades.length - 1].at > 4 * 60_000)).map(t => t.ca);
    if (!stale.length) return;
    for (let index = 0; index < stale.length; index += 50)
      sendSubscription('subscribeTokenTrade', stale.slice(index, index + 50));
    console.log(`[pumpfun] reconciler re-subscribed ${stale.length} stale-trade tokens`);
  }, 2 * 60_000);
  timer.unref();
}
export function subscribeToken(ca: string) {
  if (tradeStreamConfigured) sendSubscription('subscribeTokenTrade', [ca]);
}
function reconnect(onNew: (ca: string) => void) {
  reconnects++;
  console.log(`[pumpfun] reconnecting in ${backoff}ms`);
  const timer = setTimeout(() => connect(onNew), backoff);
  timer.unref();
  backoff = Math.min(backoff * 2, 60_000);
}
