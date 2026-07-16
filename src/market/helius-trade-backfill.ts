import { env } from '../config';
import { heliusTxs } from '../helius';
import { getStreamMode } from '../ingest/pumpfun';
import { activeTokens } from '../store';
import { TokenRecord, TradeEvent } from '../types';
import { recordTradeEvent } from './trade-events';

const WINDOW_MS = 5 * 60_000;
const POLL_INTERVAL_MS = 30_000;
const MAX_TOKENS_PER_SWEEP = 80;
const lastPoll = new Map<string, number>();
let running = false;
let started = false;

const diag = {
  startedAt: null as string | null,
  sweeps: 0,
  tokensPolled: 0,
  transactionsFetched: 0,
  eventsAdded: 0,
  lastSweep: null as string | null,
  lastError: null as string | null,
  enabled: false,
};

export const heliusTradeBackfillDiag = () => ({
  ...diag,
  streamMode: getStreamMode(),
  trackedPolls: lastPoll.size,
});

export function startHeliusTradeBackfill() {
  if (started) return;
  started = true;
  diag.enabled = !!env.HELIUS_API_KEY;
  if (!env.HELIUS_API_KEY) {
    diag.lastError = 'HELIUS_API_KEY missing; no fallback trade sequence is available in PumpPortal lite mode';
    console.warn('[helius-trades]', diag.lastError);
    return;
  }
  diag.startedAt = new Date().toISOString();
  const run = () => sweep().catch(error => {
    diag.lastError = (error as Error).message;
    console.error('[helius-trades]', diag.lastError);
  });
  setTimeout(run, 18_000);
  const timer = setInterval(run, POLL_INTERVAL_MS);
  timer.unref();
}

async function sweep() {
  if (running) return;
  running = true;
  diag.sweeps++;
  diag.lastError = null;
  try {
    const now = Date.now();
    // Do not require a high score here. In lite mode the missing trade sequence is
    // itself what suppresses organic/buy-pressure score components. Polling only high
    // scores creates a circular starvation condition.
    const candidates = activeTokens()
      .filter(token => token.dex === 'pumpfun' && token.priceUsd > 0 && (token.curveSol > 0 || token.vol5m > 0))
      .filter(token => {
        const last = lastPoll.get(token.ca) || 0;
        if (now - last < POLL_INTERVAL_MS - 1_000) return false;
        const latest = token.recentTrades[token.recentTrades.length - 1]?.at || 0;
        return getStreamMode() === 'lite' || now - latest > 75_000;
      })
      .sort((left, right) => (right.score + Math.log1p(right.vol5m)) - (left.score + Math.log1p(left.vol5m)))
      .slice(0, MAX_TOKENS_PER_SWEEP);

    for (let index = 0; index < candidates.length; index += 5) {
      await Promise.all(candidates.slice(index, index + 5).map(token => backfillToken(token, now)));
    }
    diag.lastSweep = new Date().toISOString();
  } finally {
    running = false;
  }
}

async function backfillToken(token: TokenRecord, now: number) {
  lastPoll.set(token.ca, now);
  diag.tokensPolled++;
  const transactions = await heliusTxs(token.ca, 50, undefined, 'bg');
  diag.transactionsFetched += transactions.length;
  const events = transactions
    .map(transaction => parseHeliusTrade(transaction, token))
    .filter((event): event is TradeEvent => !!event && event.at >= now - WINDOW_MS)
    .sort((left, right) => left.at - right.at);

  for (const event of events) {
    if (alreadyPresent(token, event)) continue;
    ingest(token, event, now);
    recordTradeEvent(token.ca, event);
    diag.eventsAdded++;
  }
}

export function parseHeliusTrade(transaction: any, token: TokenRecord): TradeEvent | null {
  const wallet = String(transaction?.feePayer || '');
  const timestamp = Number(transaction?.timestamp || 0) * 1_000;
  const signature = String(transaction?.signature || '');
  if (!wallet || !timestamp || !signature) return null;

  let tokenNet = 0;
  for (const transfer of transaction.tokenTransfers || []) {
    if (transfer.mint !== token.ca) continue;
    const amount = Math.max(0, Number(transfer.tokenAmount) || 0);
    if (transfer.toUserAccount === wallet) tokenNet += amount;
    if (transfer.fromUserAccount === wallet) tokenNet -= amount;
  }
  if (Math.abs(tokenNet) <= 0) return null;

  let solNetLamports = 0;
  for (const transfer of transaction.nativeTransfers || []) {
    const amount = Math.max(0, Number(transfer.amount) || 0);
    if (transfer.toUserAccount === wallet) solNetLamports += amount;
    if (transfer.fromUserAccount === wallet) solNetLamports -= amount;
  }

  return {
    at: timestamp,
    buy: tokenNet > 0,
    wallet,
    solAmount: Math.abs(solNetLamports) / 1_000_000_000 || null,
    tokenAmount: Math.abs(tokenNet),
    signature,
    slot: Number.isFinite(Number(transaction.slot)) ? Number(transaction.slot) : null,
    priceUsd: token.priceUsd > 0 ? token.priceUsd : null,
    curveSol: token.curveSol > 0 ? token.curveSol : null,
  };
}

function alreadyPresent(token: TokenRecord, event: TradeEvent): boolean {
  return token.recentTrades.some(existing => existing.signature === event.signature
    && existing.wallet === event.wallet && existing.buy === event.buy);
}

function ingest(token: TokenRecord, event: TradeEvent, now: number) {
  token.recentTrades.push(event);
  token.recentTrades.sort((left, right) => left.at - right.at);
  while (token.recentTrades.length && token.recentTrades[0].at < now - WINDOW_MS) token.recentTrades.shift();

  if (event.buy) {
    token.totalBuys++;
    if (event.wallet && !token.uniqueBuyers.includes(event.wallet) && token.uniqueBuyers.length < 800)
      token.uniqueBuyers.push(event.wallet);
    if (event.wallet && !token.earlyBuyers.includes(event.wallet) && token.earlyBuyers.length < 30)
      token.earlyBuyers.push(event.wallet);
  } else {
    token.totalSells++;
    if (event.wallet && token.earlyBuyers.includes(event.wallet) && !token.earlyExited.includes(event.wallet))
      token.earlyExited.push(event.wallet);
  }
  token.buys5m = token.recentTrades.filter(trade => trade.buy).length;
  token.sells5m = token.recentTrades.length - token.buys5m;
}
