import WebSocket from 'ws';
import { BtcMultiStrategyEngine } from './platform/engine';
import { buildCrossAssetState, TimedPrice } from './platform/cross-asset';
import { assessOrderbookSequence } from './platform/bybit-sequence';
import { classifyRegime, clamp, median, safeDiv } from './platform/indicators';
import {
  BtcDirection,
  BookLevel,
  Candle,
  FeedQuality,
  MarketContext,
  OrderFlowState,
  PlatformStatus,
} from './platform/types';

interface TradeTick {
  at: number;
  price: number;
  size: number;
  usd: number;
  direction: BtcDirection;
  source: 'perp' | 'spot';
}

interface LiquidationTick {
  at: number;
  usd: number;
  side: 'long' | 'short';
}

const PRODUCT = 'BTCUSDT';
const COINBASE_PRODUCT = 'BTC-USD';
const COINBASE_ETH_PRODUCT = 'ETH-USD';
const REFERENCE_VENUE = process.env.BTC_REFERENCE_VENUE || 'BYBIT-BTCUSDT';
const BYBIT_WS = process.env.BTC_REFERENCE_PERP_WS || 'wss://stream.bybit.com/v5/public/linear';
const INTERVALS = [60, 300, 900, 3600, 14_400] as const;
const engine = new BtcMultiStrategyEngine();
const candles = new Map<number, Candle[]>(INTERVALS.map(interval => [interval, []]));
const bids = new Map<number, number>();
const asks = new Map<number, number>();
const trades: TradeTick[] = [];
const liquidations: LiquidationTick[] = [];
const ethObservations: TimedPrice[] = [];

let started = false;
let bybitSocket: WebSocket | null = null;
let coinbaseSocket: WebSocket | null = null;
let bybitReconnect: NodeJS.Timeout | null = null;
let coinbaseReconnect: NodeJS.Timeout | null = null;
let bybitReconnectAttempt = 0;
let coinbaseReconnectAttempt = 0;
let latestBybitAt: number | null = null;
let latestCoinbaseAt: number | null = null;
let latestKrakenAt: number | null = null;
let latestEthAt: number | null = null;
let sequenceGapAt: number | null = null;
let orderbookUpdateId: number | null = null;
let lastPrice = 0;
let bidPrice = 0;
let askPrice = 0;
let markPrice = 0;
let indexPrice = 0;
let coinbasePrice: number | null = null;
let krakenPrice: number | null = null;
let ethPrice: number | null = null;
let fundingRate = 0;
let predictedFundingRate = 0;
let nextFundingAt: number | null = null;
let openInterest = 0;
let openInterestValue = 0;
const openInterestObservations: Array<{ at: number; value: number }> = [];
let evaluation = Promise.resolve();
let pingTimer: NodeJS.Timeout | null = null;
let evaluationTimer: NodeJS.Timeout | null = null;
let krakenTimer: NodeJS.Timeout | null = null;
let status: PlatformStatus | null = null;

const numeric = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};
const list = (interval: number): Candle[] => candles.get(interval) || [];

function recordEthPrice(price: number, at = Date.now()): void {
  if (!(price > 0 && Number.isFinite(at))) return;
  ethPrice = price;
  latestEthAt = Date.now();
  const previous = ethObservations.at(-1);
  if (previous && Math.abs(previous.at - at) < 1_000) {
    previous.at = at;
    previous.price = price;
  } else {
    ethObservations.push({ at, price });
  }
}

function prune(): void {
  const cutoff = Date.now() - 30 * 60_000;
  const crossAssetCutoff = Date.now() - 2 * 60 * 60_000;
  while (trades.length && trades[0].at < cutoff) trades.shift();
  while (liquidations.length && liquidations[0].at < cutoff) liquidations.shift();
  while (ethObservations.length && ethObservations[0].at < crossAssetCutoff) ethObservations.shift();
  const oiCutoff = Date.now() - 90 * 60_000;
  while (openInterestObservations.length && openInterestObservations[0].at < oiCutoff) openInterestObservations.shift();
}

function recordOpenInterest(value: number, at = Date.now()): void {
  if (!(value > 0 && Number.isFinite(at))) return;
  const latest = openInterestObservations.at(-1);
  if (latest && at - latest.at < 5_000) {
    latest.at = at;
    latest.value = value;
  } else {
    openInterestObservations.push({ at, value });
  }
  const cutoff = at - 90 * 60_000;
  while (openInterestObservations.length && openInterestObservations[0].at < cutoff) openInterestObservations.shift();
}

function rollingOpenInterestChangePct(minutes = 15, now = Date.now()): number {
  const target = now - minutes * 60_000;
  const baseline = [...openInterestObservations].reverse().find(item => item.at <= target)
    || openInterestObservations[0];
  return baseline?.value > 0 && openInterest > 0 ? (openInterest / baseline.value - 1) * 100 : 0;
}

function updateCandle(interval: number, price: number, size: number, at: number, direction: BtcDirection): void {
  const series = list(interval);
  const startMs = Math.floor(at / (interval * 1000)) * interval * 1000;
  let candle = series.at(-1);
  if (!candle || candle.startMs !== startMs) {
    if (candle && candle.startMs < startMs) candle.complete = true;
    candle = {
      timeframeSec: interval,
      startMs,
      open: price,
      high: price,
      low: price,
      close: price,
      volume: 0,
      tradeCount: 0,
      buyVolume: 0,
      sellVolume: 0,
      complete: false,
    };
    series.push(candle);
    if (series.length > 3000) series.splice(0, series.length - 3000);
  }
  candle.high = Math.max(candle.high, price);
  candle.low = Math.min(candle.low, price);
  candle.close = price;
  candle.volume += size;
  candle.tradeCount++;
  if (direction === 'long') candle.buyVolume += size;
  else candle.sellVolume += size;
}

function recordTrade(price: number, size: number, at: number, direction: BtcDirection, source: 'perp' | 'spot'): void {
  if (!(price > 0 && size > 0 && Number.isFinite(at))) return;
  trades.push({ at, price, size, usd: price * size, direction, source });
  prune();
  const derivativesFresh = latestBybitAt !== null && Date.now() - latestBybitAt < 12_000;
  if (source === 'perp' || !derivativesFresh) {
    for (const interval of INTERVALS) updateCandle(interval, price, size, at, direction);
  }
}

function requestOrderbookResync(now = Date.now()): void {
  sequenceGapAt = now;
  orderbookUpdateId = null;
  bids.clear();
  asks.clear();
  const socket = bybitSocket;
  if (socket?.readyState === WebSocket.OPEN) {
    socket.close(1012, 'orderbook sequence gap');
  }
}

function setBookSide(map: Map<number, number>, levels: unknown): void {
  if (!Array.isArray(levels)) return;
  for (const row of levels) {
    if (!Array.isArray(row) || row.length < 2) continue;
    const price = numeric(row[0]);
    const size = Number(row[1]);
    if (!price || !Number.isFinite(size) || size < 0) continue;
    if (size === 0) map.delete(price);
    else map.set(price, size);
  }
}

function parseBybit(raw: WebSocket.RawData): void {
  let message: any;
  try { message = JSON.parse(raw.toString()); } catch { return; }
  if (message.op === 'pong' || message.ret_msg === 'pong') return;
  const topic = String(message.topic || '');
  const now = Date.now();

  if (topic === `tickers.${PRODUCT}`) {
    const row = Array.isArray(message.data) ? message.data[0] : message.data;
    if (!row) return;
    lastPrice = numeric(row.lastPrice) ?? lastPrice;
    bidPrice = numeric(row.bid1Price) ?? bidPrice;
    askPrice = numeric(row.ask1Price) ?? askPrice;
    markPrice = numeric(row.markPrice) ?? markPrice;
    indexPrice = numeric(row.indexPrice) ?? indexPrice;
    fundingRate = Number.isFinite(Number(row.fundingRate)) ? Number(row.fundingRate) : fundingRate;
    predictedFundingRate = fundingRate;
    nextFundingAt = numeric(row.nextFundingTime) ?? nextFundingAt;
    const nextOi = numeric(row.openInterest) ?? openInterest;
    const nextOiValue = numeric(row.openInterestValue) ?? openInterestValue;
    openInterest = nextOi;
    openInterestValue = nextOiValue;
    recordOpenInterest(nextOi, now);
    latestBybitAt = now;
    return;
  }

  if (topic === `publicTrade.${PRODUCT}` && Array.isArray(message.data)) {
    latestBybitAt = now;
    for (const row of message.data) {
      const price = numeric(row.p);
      const size = numeric(row.v);
      const at = Number(row.T || message.ts || now);
      const direction: BtcDirection = String(row.S).toLowerCase() === 'buy' ? 'long' : 'short';
      if (price && size) {
        lastPrice = price;
        recordTrade(price, size, at, direction, 'perp');
      }
    }
    return;
  }

  if (topic === `orderbook.50.${PRODUCT}`) {
    const decision = assessOrderbookSequence(orderbookUpdateId, message.type, message.data?.u);
    if (decision.gap) {
      requestOrderbookResync(now);
      return;
    }
    if (!decision.accept) return;
    if (decision.reset) {
      bids.clear();
      asks.clear();
      sequenceGapAt = null;
    }
    orderbookUpdateId = decision.current;
    setBookSide(bids, message.data?.b);
    setBookSide(asks, message.data?.a);
    const bestBid = [...bids.keys()].sort((a, b) => b - a)[0];
    const bestAsk = [...asks.keys()].sort((a, b) => a - b)[0];
    if (bestBid) bidPrice = bestBid;
    if (bestAsk) askPrice = bestAsk;
    latestBybitAt = now;
    return;
  }

  if (topic === `allLiquidation.${PRODUCT}` && Array.isArray(message.data)) {
    latestBybitAt = now;
    for (const row of message.data) {
      const price = numeric(row.p);
      const size = numeric(row.v);
      const at = Number(row.T || message.ts || now);
      if (!price || !size) continue;
      liquidations.push({
        at,
        usd: price * size,
        side: String(row.S).toLowerCase() === 'buy' ? 'long' : 'short',
      });
    }
    prune();
  }
}

function connectBybit(): void {
  const ws = new WebSocket(BYBIT_WS);
  bybitSocket = ws;
  ws.on('open', () => {
    bybitReconnectAttempt = 0;
    orderbookUpdateId = null;
    ws.send(JSON.stringify({
      op: 'subscribe',
      args: [`tickers.${PRODUCT}`, `publicTrade.${PRODUCT}`, `orderbook.50.${PRODUCT}`, `allLiquidation.${PRODUCT}`],
    }));
  });
  ws.on('message', parseBybit);
  ws.on('error', error => console.error('[btc-bybit]', error.message));
  ws.on('close', () => {
    if (bybitSocket === ws) bybitSocket = null;
    if (bybitReconnect) return;
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(bybitReconnectAttempt++, 5));
    bybitReconnect = setTimeout(() => { bybitReconnect = null; connectBybit(); }, delay);
    bybitReconnect.unref();
  });
}

function parseCoinbase(raw: WebSocket.RawData): void {
  let message: any;
  try { message = JSON.parse(raw.toString()); } catch { return; }
  const now = Date.now();
  if (message.channel === 'ticker') {
    for (const event of message.events || []) for (const ticker of event.tickers || []) {
      const price = numeric(ticker.price);
      const productId = String(ticker.product_id || event.product_id || '');
      if (!price) continue;
      if (productId === COINBASE_ETH_PRODUCT) {
        recordEthPrice(price, now);
      } else if (productId === COINBASE_PRODUCT || !productId) {
        coinbasePrice = price;
        latestCoinbaseAt = now;
      }
    }
  }
  if (message.channel === 'market_trades') {
    for (const event of message.events || []) for (const trade of event.trades || []) {
      const price = numeric(trade.price);
      const size = numeric(trade.size);
      const at = Date.parse(String(trade.time || message.timestamp || ''));
      const productId = String(trade.product_id || event.product_id || '');
      if (!price || !Number.isFinite(at)) continue;
      if (productId === COINBASE_ETH_PRODUCT) {
        recordEthPrice(price, at);
        continue;
      }
      if (productId !== COINBASE_PRODUCT && productId) continue;
      if (!size) continue;
      const direction: BtcDirection = String(trade.side).toUpperCase() === 'BUY' ? 'short' : 'long';
      coinbasePrice = price;
      latestCoinbaseAt = now;
      recordTrade(price, size, at, direction, 'spot');
    }
  }
  prune();
}

function connectCoinbase(): void {
  const ws = new WebSocket('wss://advanced-trade-ws.coinbase.com');
  coinbaseSocket = ws;
  ws.on('open', () => {
    coinbaseReconnectAttempt = 0;
    for (const channel of ['heartbeats', 'ticker', 'market_trades']) {
      ws.send(JSON.stringify({
        type: 'subscribe',
        channel,
        ...(channel === 'heartbeats' ? {} : { product_ids: [COINBASE_PRODUCT, COINBASE_ETH_PRODUCT] }),
      }));
    }
  });
  ws.on('message', parseCoinbase);
  ws.on('error', error => console.error('[btc-coinbase]', error.message));
  ws.on('close', () => {
    if (coinbaseSocket === ws) coinbaseSocket = null;
    if (coinbaseReconnect) return;
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(coinbaseReconnectAttempt++, 5));
    coinbaseReconnect = setTimeout(() => { coinbaseReconnect = null; connectCoinbase(); }, delay);
    coinbaseReconnect.unref();
  });
}

async function pollKraken(): Promise<void> {
  try {
    const response = await fetch('https://api.kraken.com/0/public/Ticker?pair=XBTUSD', {
      headers: { Accept: 'application/json', 'User-Agent': 'Memebot-BTC-Research/2.0' },
    });
    if (!response.ok) return;
    const payload = await response.json() as any;
    const row = Object.values(payload?.result || {})[0] as any;
    krakenPrice = numeric(row?.c?.[0]);
    if (krakenPrice) latestKrakenAt = Date.now();
  } catch (error) {
    console.error('[btc-kraken]', (error as Error).message);
  }
}

function mapBybitCandle(interval: number, row: unknown): Candle | null {
  if (!Array.isArray(row) || row.length < 6) return null;
  const startMs = Number(row[0]);
  const open = Number(row[1]);
  const high = Number(row[2]);
  const low = Number(row[3]);
  const close = Number(row[4]);
  const volume = Number(row[5]);
  if (![startMs, open, high, low, close, volume].every(Number.isFinite)) return null;
  return {
    timeframeSec: interval,
    startMs,
    open,
    high,
    low,
    close,
    volume,
    tradeCount: 0,
    buyVolume: 0,
    sellVolume: 0,
    complete: startMs + interval * 1000 <= Date.now() - 2_000,
  };
}

async function bybitHistory(interval: 60 | 300 | 900 | 3600 | 14_400): Promise<Candle[]> {
  const intervalCode = interval === 60 ? '1' : interval === 300 ? '5' : interval === 900 ? '15' : interval === 3600 ? '60' : '240';
  const response = await fetch(`https://api.bybit.com/v5/market/kline?category=linear&symbol=${PRODUCT}&interval=${intervalCode}&limit=1000`, {
    headers: { Accept: 'application/json', 'User-Agent': 'Memebot-BTC-Research/2.0' },
  });
  if (!response.ok) throw new Error(`Bybit history ${intervalCode} returned ${response.status}`);
  const payload = await response.json() as any;
  if (Number(payload?.retCode) !== 0 || !Array.isArray(payload?.result?.list)) throw new Error(`Bybit history ${intervalCode} payload invalid`);
  return payload.result.list.map((row: unknown) => mapBybitCandle(interval, row))
    .filter((row: Candle | null): row is Candle => row !== null)
    .sort((a: Candle, b: Candle) => a.startMs - b.startMs);
}

async function coinbaseHistory(interval: 60 | 300 | 900 | 3600): Promise<Candle[]> {
  const response = await fetch(`https://api.exchange.coinbase.com/products/${COINBASE_PRODUCT}/candles?granularity=${interval}`, {
    headers: { Accept: 'application/json', 'User-Agent': 'Memebot-BTC-Research/2.0' },
  });
  if (!response.ok) throw new Error(`Coinbase history ${interval} returned ${response.status}`);
  const payload = await response.json() as unknown;
  if (!Array.isArray(payload)) throw new Error('Coinbase history payload invalid');
  return payload.map((row): Candle | null => {
    if (!Array.isArray(row) || row.length < 6) return null;
    const [seconds, low, high, open, close, volume] = row.slice(0, 6).map(Number);
    if (![seconds, low, high, open, close, volume].every(Number.isFinite)) return null;
    return {
      timeframeSec: interval,
      startMs: seconds * 1000,
      open, high, low, close, volume,
      tradeCount: 0, buyVolume: 0, sellVolume: 0,
      complete: seconds * 1000 + interval * 1000 <= Date.now() - 2_000,
    };
  }).filter((row): row is Candle => row !== null).sort((a, b) => a.startMs - b.startMs);
}

function aggregate(source: Candle[], interval: number): Candle[] {
  const grouped = new Map<number, Candle>();
  for (const candle of source) {
    const startMs = Math.floor(candle.startMs / (interval * 1000)) * interval * 1000;
    const existing = grouped.get(startMs);
    if (!existing) {
      grouped.set(startMs, { ...candle, timeframeSec: interval, startMs });
    } else {
      existing.high = Math.max(existing.high, candle.high);
      existing.low = Math.min(existing.low, candle.low);
      existing.close = candle.close;
      existing.volume += candle.volume;
      existing.tradeCount += candle.tradeCount;
      existing.buyVolume += candle.buyVolume;
      existing.sellVolume += candle.sellVolume;
      existing.complete = existing.complete && candle.complete;
    }
  }
  return [...grouped.values()].sort((a, b) => a.startMs - b.startMs);
}

async function warmEthHistory(): Promise<void> {
  const response = await fetch(`https://api.exchange.coinbase.com/products/${COINBASE_ETH_PRODUCT}/candles?granularity=60`, {
    headers: { Accept: 'application/json', 'User-Agent': 'Memebot-BTC-Research/2.0' },
  });
  if (!response.ok) throw new Error(`Coinbase ETH history returned ${response.status}`);
  const payload = await response.json() as unknown;
  if (!Array.isArray(payload)) throw new Error('Coinbase ETH history payload invalid');
  const history = payload.map((row): TimedPrice | null => {
    if (!Array.isArray(row) || row.length < 6) return null;
    const at = Number(row[0]) * 1000;
    const price = Number(row[4]);
    return Number.isFinite(at) && price > 0 ? { at, price } : null;
  }).filter((row): row is TimedPrice => row !== null)
    .sort((a, b) => a.at - b.at)
    .slice(-120);
  ethObservations.splice(0, ethObservations.length, ...history);
  const latest = history.at(-1);
  if (latest) ethPrice = latest.price;
  console.log('[btc] warmed ETH cross-asset history');
}

async function warmHistory(): Promise<void> {
  let referenceHistoryLoaded = false;
  try {
    const results = await Promise.all(INTERVALS.map(interval => bybitHistory(interval)));
    INTERVALS.forEach((interval, index) => candles.set(interval, results[index]));
    referenceHistoryLoaded = true;
    console.log('[btc] warmed reference-perpetual history');
  } catch (error) {
    console.error('[btc] reference history unavailable; using Coinbase fallback:', (error as Error).message);
  }
  if (!referenceHistoryLoaded) {
    const [m1, m5, m15, h1] = await Promise.all([
      coinbaseHistory(60), coinbaseHistory(300), coinbaseHistory(900), coinbaseHistory(3600),
    ]);
    candles.set(60, m1);
    candles.set(300, m5);
    candles.set(900, m15);
    candles.set(3600, h1);
    candles.set(14_400, aggregate(h1, 14_400));
  }
  await warmEthHistory().catch(error => {
    console.error('[btc] ETH cross-asset history unavailable; waiting for live samples:', (error as Error).message);
  });
}

function sortedLevels(map: Map<number, number>, direction: 'bids' | 'asks', count = 20): BookLevel[] {
  return [...map.entries()]
    .sort((a, b) => direction === 'bids' ? b[0] - a[0] : a[0] - b[0])
    .slice(0, count)
    .map(([price, size]) => ({ price, size }));
}

function flowSince(milliseconds: number, source: 'perp' | 'spot' | 'all' = 'all'): {
  buy: number; sell: number; movePct: number; signedMovePct: number;
} {
  const cutoff = Date.now() - milliseconds;
  const sample = trades.filter(trade => trade.at >= cutoff && (source === 'all' || trade.source === source));
  const buy = sample.filter(trade => trade.direction === 'long').reduce((sum, trade) => sum + trade.usd, 0);
  const sell = sample.filter(trade => trade.direction === 'short').reduce((sum, trade) => sum + trade.usd, 0);
  const first = sample[0]?.price || 0;
  const final = sample.at(-1)?.price || first;
  const signedMovePct = first > 0 ? (final / first - 1) * 100 : 0;
  return { buy, sell, movePct: Math.abs(signedMovePct), signedMovePct };
}

function orderFlowState(): OrderFlowState {
  const bidLevels = sortedLevels(bids, 'bids');
  const askLevels = sortedLevels(asks, 'asks');
  const one = flowSince(60_000, latestBybitAt && Date.now() - latestBybitAt < 12_000 ? 'perp' : 'all');
  const five = flowSince(5 * 60_000, latestBybitAt && Date.now() - latestBybitAt < 12_000 ? 'perp' : 'all');
  const bestBidSize = bidLevels[0]?.size || 0;
  const bestAskSize = askLevels[0]?.size || 0;
  const topBookImbalance = safeDiv(bestBidSize - bestAskSize, bestBidSize + bestAskSize, 0);
  const reference = markPrice || lastPrice || coinbasePrice || 0;
  const bidDepth = bidLevels.filter(level => reference && (reference - level.price) / reference <= 0.0005)
    .reduce((sum, level) => sum + level.price * level.size, 0);
  const askDepth = askLevels.filter(level => reference && (level.price - reference) / reference <= 0.0005)
    .reduce((sum, level) => sum + level.price * level.size, 0);
  const depthImbalance5Bps = safeDiv(bidDepth - askDepth, bidDepth + askDepth, 0);
  const totalDepth = bidDepth + askDepth;
  const bookFragility = clamp(1 - safeDiv(totalDepth, Math.max(five.buy + five.sell, 1), 0), 0, 1);
  const signedFlowImbalance = safeDiv(one.buy - one.sell, one.buy + one.sell, 0);
  const flowImbalance = Math.abs(signedFlowImbalance);
  const expectedMove = safeDiv(flowImbalance * (one.buy + one.sell), Math.max(totalDepth, 1), 0);
  const buyPressure = Math.max(0, signedFlowImbalance);
  const sellPressure = Math.max(0, -signedFlowImbalance);
  const buyAbsorptionScore = clamp(
    buyPressure * 0.45
      + (buyPressure >= 0.2 && one.signedMovePct <= 0.015 ? 0.25 : 0)
      + (buyPressure >= 0.2 && one.signedMovePct < 0 ? 0.2 : 0)
      + Math.max(0, -depthImbalance5Bps) * 0.15,
    0,
    1,
  );
  const sellAbsorptionScore = clamp(
    sellPressure * 0.45
      + (sellPressure >= 0.2 && one.signedMovePct >= -0.015 ? 0.25 : 0)
      + (sellPressure >= 0.2 && one.signedMovePct > 0 ? 0.2 : 0)
      + Math.max(0, depthImbalance5Bps) * 0.15,
    0,
    1,
  );
  const absorptionScore = Math.max(buyAbsorptionScore, sellAbsorptionScore);
  return {
    aggressiveBuyUsd1m: one.buy,
    aggressiveSellUsd1m: one.sell,
    aggressiveBuyUsd5m: five.buy,
    aggressiveSellUsd5m: five.sell,
    topBookImbalance,
    depthImbalance5Bps,
    bookFragility,
    absorptionScore,
    signedMovePct1m: one.signedMovePct,
    buyAbsorptionScore,
    sellAbsorptionScore,
    bids: bidLevels,
    asks: askLevels,
  };
}

function quality(now = Date.now()): FeedQuality {
  const referenceAgeMs = latestBybitAt === null ? null : now - latestBybitAt;
  const coinbaseAgeMs = latestCoinbaseAt === null ? null : now - latestCoinbaseAt;
  const krakenAgeMs = latestKrakenAt === null ? null : now - latestKrakenAt;
  const referenceFresh = referenceAgeMs !== null && referenceAgeMs < 12_000 && markPrice > 0 && indexPrice > 0;
  const fallbackFresh = coinbaseAgeMs !== null && coinbaseAgeMs < 15_000 && !!coinbasePrice;
  const effectiveBid = referenceFresh ? bidPrice : coinbasePrice || 0;
  const effectiveAsk = referenceFresh ? askPrice : coinbasePrice || 0;
  const effectiveMark = referenceFresh ? markPrice : coinbasePrice || 0;
  const fairValues = [coinbasePrice, krakenPrice].filter((value): value is number => !!value && value > 0);
  const fair = fairValues.length ? median(fairValues) : indexPrice || effectiveMark;
  const spreadBps = effectiveBid && effectiveAsk ? (effectiveAsk - effectiveBid) / ((effectiveAsk + effectiveBid) / 2) * 10_000 : null;
  const markIndexBps = referenceFresh ? Math.abs(markPrice - indexPrice) / ((markPrice + indexPrice) / 2) * 10_000 : null;
  const crossVenueBps = effectiveMark && fair ? Math.abs(effectiveMark - fair) / ((effectiveMark + fair) / 2) * 10_000 : null;
  const recentSequenceGap = sequenceGapAt !== null;
  const blockers: string[] = [];
  if (!referenceFresh && !fallbackFresh) blockers.push('both reference-perpetual and Coinbase fallback prices are stale');
  if (coinbaseAgeMs === null || coinbaseAgeMs > 30_000) blockers.push('Coinbase spot validation is stale');
  if (krakenAgeMs === null || krakenAgeMs > 60_000) blockers.push('Kraken spot validation is stale');
  if (spreadBps === null || spreadBps > 15) blockers.push('executable spread is abnormal');
  if (markIndexBps !== null && markIndexBps > 35) blockers.push('reference mark/index divergence is abnormal');
  if (crossVenueBps !== null && crossVenueBps > 45) blockers.push('reference market and spot validation disagree');
  if (recentSequenceGap) blockers.push('order-book resynchronization is pending after a sequence gap');
  return {
    healthy: blockers.filter(reason => !reason.includes('reference-perpetual')).length === 0 && (referenceFresh || fallbackFresh),
    derivativesHealthy: referenceFresh,
    referenceVenue: REFERENCE_VENUE,
    referenceAgeMs,
    coinbaseAgeMs,
    krakenAgeMs,
    spreadBps,
    markIndexBps,
    crossVenueBps,
    recentSequenceGap,
    blockers,
  };
}

function buildContext(): MarketContext | null {
  const feed = quality();
  const referenceFresh = feed.derivativesHealthy;
  const mark = referenceFresh ? markPrice : coinbasePrice || lastPrice;
  const index = referenceFresh ? indexPrice : median([coinbasePrice, krakenPrice].filter((value): value is number => !!value));
  const bid = referenceFresh ? bidPrice : coinbasePrice || mark;
  const ask = referenceFresh ? askPrice : coinbasePrice || mark;
  const last = referenceFresh ? lastPrice : coinbasePrice || mark;
  if (!(mark > 0 && index > 0 && bid > 0 && ask > 0 && last > 0)) return null;
  const fairCandidates = [coinbasePrice, krakenPrice, index].filter((value): value is number => !!value && value > 0);
  const fair = median(fairCandidates);
  const flow = orderFlowState();
  const now = Date.now();
  const longLiquidationUsd5m = liquidations.filter(item => item.at >= now - 5 * 60_000 && item.side === 'long').reduce((sum, item) => sum + item.usd, 0);
  const shortLiquidationUsd5m = liquidations.filter(item => item.at >= now - 5 * 60_000 && item.side === 'short').reduce((sum, item) => sum + item.usd, 0);
  const openInterestChangePct = rollingOpenInterestChangePct(15, now);
  const base = {
    timestamp: now,
    prices: {
      last, bid, ask, mark, index,
      coinbaseSpot: coinbasePrice,
      krakenSpot: krakenPrice,
      consolidatedFair: fair,
    },
    candles: {
      oneMinute: list(60),
      fiveMinute: list(300),
      fifteenMinute: list(900),
      oneHour: list(3600),
      fourHour: list(14_400),
    },
    derivatives: {
      fundingRate,
      predictedFundingRate,
      nextFundingAt,
      openInterest,
      openInterestValue,
      openInterestChangePct,
      longLiquidationUsd5m,
      shortLiquidationUsd5m,
      basisBps: index > 0 ? (mark - index) / index * 10_000 : 0,
    },
    orderFlow: flow,
    crossAsset: buildCrossAssetState({
      now,
      currentBtc: mark,
      btcOneMinuteCandles: list(60),
      currentEth: ethPrice,
      ethObservations,
      latestEthAt,
    }),
    feed,
  };
  return { ...base, regime: classifyRegime(base) };
}

async function evaluate(): Promise<void> {
  const context = buildContext();
  if (!context) return;
  await engine.evaluate(context);
  status = engine.getStatus();
}

export async function startBtcPaperEngine(): Promise<void> {
  if (started) return;
  started = true;
  await engine.initialize();
  await warmHistory();
  await pollKraken();
  connectBybit();
  connectCoinbase();
  pingTimer = setInterval(() => {
    if (bybitSocket?.readyState === WebSocket.OPEN) bybitSocket.send(JSON.stringify({ op: 'ping' }));
  }, 20_000);
  pingTimer.unref();
  krakenTimer = setInterval(() => void pollKraken(), 15_000);
  krakenTimer.unref();
  evaluationTimer = setInterval(() => {
    evaluation = evaluation.then(evaluate).catch(error => console.error('[btc-platform]', (error as Error).message));
  }, 5_000);
  evaluationTimer.unref();
  await evaluate();
  console.log('[btc] multistrategy leveraged paper platform active');
}

export async function getBtcStatus(): Promise<PlatformStatus> {
  status = status || engine.getStatus();
  return status;
}
