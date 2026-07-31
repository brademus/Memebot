import WebSocket from 'ws';

interface VenueBook { bids: Map<number, number>; asks: Map<number, number>; updatedAt: number | null }
interface OptionTick { expiry: number; delta: number; iv: number; openInterest: number }

export interface BtcMarketIntelligenceSnapshot {
  generatedAt: number;
  healthy: boolean;
  blockers: string[];
  coinbaseDepthImbalance5Bps: number | null;
  krakenDepthImbalance5Bps: number | null;
  consolidatedSpotDepthImbalance5Bps: number | null;
  coinbaseTradeDeltaUsd10s: number;
  krakenTradeDeltaUsd10s: number;
  deribitPerpetualOpenInterest: number | null;
  deribitFundingRate: number | null;
  deribitBasisBps: number | null;
  btcIv7d: number | null;
  btcIv30d: number | null;
  btc25dSkew: number | null;
  ivTermSlope: number | null;
  optionContractsObserved: number;
  venueAgesMs: Record<string, number | null>;
}

const coinbaseBook: VenueBook = { bids: new Map(), asks: new Map(), updatedAt: null };
const krakenBook: VenueBook = { bids: new Map(), asks: new Map(), updatedAt: null };
const trades: Array<{ at: number; venue: 'coinbase' | 'kraken'; signedUsd: number }> = [];
const options = new Map<string, OptionTick>();
let started = false;
let deribitOpenInterest: number | null = null;
let deribitFundingRate: number | null = null;
let deribitMark: number | null = null;
let deribitIndex: number | null = null;
let latestDeribitAt: number | null = null;
let requestId = 1;

const numeric = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

function reconnect(label: string, connect: () => void): void {
  const timer = setTimeout(connect, 5_000 + Math.floor(Math.random() * 2_000));
  timer.unref();
  console.warn(`[btc-${label}] reconnect scheduled`);
}

function setLevels(side: Map<number, number>, rows: unknown, replace = false): void {
  if (replace) side.clear();
  if (!Array.isArray(rows)) return;
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 2) continue;
    const price = numeric(row[0]);
    const size = numeric(row[1]);
    if (!(price && size !== null && size >= 0)) continue;
    if (size === 0) side.delete(price);
    else side.set(price, size);
  }
}

function depthImbalance(book: VenueBook, reference: number): number | null {
  if (!(reference > 0) || !book.bids.size || !book.asks.size) return null;
  let bid = 0;
  let ask = 0;
  for (const [price, size] of book.bids) if ((reference - price) / reference <= 0.0005) bid += price * size;
  for (const [price, size] of book.asks) if ((price - reference) / reference <= 0.0005) ask += price * size;
  return bid + ask > 0 ? (bid - ask) / (bid + ask) : null;
}

function prune(now = Date.now()): void {
  while (trades.length && trades[0].at < now - 60_000) trades.shift();
  for (const [key, tick] of options) if (tick.expiry < now - 60_000) options.delete(key);
}

function connectCoinbase(): void {
  const ws = new WebSocket('wss://ws-feed.exchange.coinbase.com');
  ws.on('open', () => ws.send(JSON.stringify({ type: 'subscribe', product_ids: ['BTC-USD'], channels: ['level2', 'matches', 'heartbeat'] })));
  ws.on('message', raw => {
    let message: any;
    try { message = JSON.parse(raw.toString()); } catch { return; }
    const now = Date.now();
    if (message.type === 'snapshot') {
      setLevels(coinbaseBook.bids, message.bids, true);
      setLevels(coinbaseBook.asks, message.asks, true);
      coinbaseBook.updatedAt = now;
    } else if (message.type === 'l2update') {
      for (const change of message.changes || []) setLevels(change[0] === 'buy' ? coinbaseBook.bids : coinbaseBook.asks, [[change[1], change[2]]]);
      coinbaseBook.updatedAt = now;
    } else if (message.type === 'match' || message.type === 'last_match') {
      const price = numeric(message.price);
      const size = numeric(message.size);
      if (price && size) trades.push({ at: Date.parse(message.time) || now, venue: 'coinbase', signedUsd: price * size * (message.side === 'sell' ? 1 : -1) });
    }
    prune(now);
  });
  ws.on('error', error => console.error('[btc-coinbase-l2]', error.message));
  ws.on('close', () => reconnect('coinbase-l2', connectCoinbase));
}

function connectKraken(): void {
  const ws = new WebSocket('wss://ws.kraken.com/v2');
  ws.on('open', () => {
    ws.send(JSON.stringify({ method: 'subscribe', params: { channel: 'book', symbol: ['BTC/USD'], depth: 100, snapshot: true } }));
    ws.send(JSON.stringify({ method: 'subscribe', params: { channel: 'trade', symbol: ['BTC/USD'], snapshot: false } }));
  });
  ws.on('message', raw => {
    let message: any;
    try { message = JSON.parse(raw.toString()); } catch { return; }
    const now = Date.now();
    if (message.channel === 'book') {
      for (const row of message.data || []) {
        setLevels(krakenBook.bids, (row.bids || []).map((x: any) => [x.price, x.qty]), message.type === 'snapshot');
        setLevels(krakenBook.asks, (row.asks || []).map((x: any) => [x.price, x.qty]), message.type === 'snapshot');
      }
      krakenBook.updatedAt = now;
    } else if (message.channel === 'trade') {
      for (const row of message.data || []) {
        const price = numeric(row.price);
        const qty = numeric(row.qty);
        if (price && qty) trades.push({ at: Date.parse(row.timestamp) || now, venue: 'kraken', signedUsd: price * qty * (row.side === 'buy' ? 1 : -1) });
      }
    }
    prune(now);
  });
  ws.on('error', error => console.error('[btc-kraken-l2]', error.message));
  ws.on('close', () => reconnect('kraken-l2', connectKraken));
}

async function optionInstruments(): Promise<string[]> {
  const response = await fetch('https://www.deribit.com/api/v2/public/get_instruments?currency=BTC&kind=option&expired=false');
  if (!response.ok) throw new Error(`Deribit instruments returned ${response.status}`);
  const payload = await response.json() as any;
  const rows: any[] = Array.isArray(payload?.result) ? payload.result : [];
  const now = Date.now();
  const expiries: number[] = Array.from(new Set<number>(
    rows.map(row => Number(row.expiration_timestamp)).filter(value => Number.isFinite(value) && value > now),
  )).sort((left, right) => left - right).slice(0, 3);
  return rows.filter(row => expiries.includes(Number(row.expiration_timestamp))).map(row => String(row.instrument_name)).slice(0, 120);
}

function connectDeribit(): void {
  const ws = new WebSocket('wss://www.deribit.com/ws/api/v2');
  ws.on('open', async () => {
    const instruments = await optionInstruments().catch(error => { console.error('[btc-deribit-options]', error.message); return []; });
    const channels = ['ticker.BTC-PERPETUAL.100ms', 'deribit_price_index.btc_usd', ...instruments.map(name => `ticker.${name}.agg2`)];
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: requestId++, method: 'public/subscribe', params: { channels } }));
  });
  ws.on('message', raw => {
    let message: any;
    try { message = JSON.parse(raw.toString()); } catch { return; }
    if (message.method !== 'subscription') return;
    const channel = String(message.params?.channel || '');
    const data = message.params?.data || {};
    const now = Date.now();
    latestDeribitAt = now;
    if (channel === 'ticker.BTC-PERPETUAL.100ms') {
      deribitOpenInterest = numeric(data.open_interest);
      deribitFundingRate = numeric(data.current_funding);
      deribitMark = numeric(data.mark_price);
      deribitIndex = numeric(data.index_price);
      return;
    }
    if (!channel.startsWith('ticker.BTC-')) return;
    const instrument = String(data.instrument_name || channel.split('.')[1] || '');
    const expiry = Date.parse(instrument.split('-')[1] || '');
    const delta = numeric(data.greeks?.delta);
    const iv = numeric(data.mark_iv);
    const openInterest = numeric(data.open_interest) || 0;
    if (instrument && Number.isFinite(expiry) && delta !== null && iv !== null) options.set(instrument, { expiry, delta, iv, openInterest });
  });
  ws.on('error', error => console.error('[btc-deribit]', error.message));
  ws.on('close', () => reconnect('deribit', connectDeribit));
}

function weightedAverage(rows: OptionTick[]): number | null {
  const weight = rows.reduce((sum, row) => sum + Math.max(row.openInterest, 1), 0);
  return weight > 0 ? rows.reduce((sum, row) => sum + row.iv * Math.max(row.openInterest, 1), 0) / weight : null;
}

function optionMetrics(now: number) {
  const rows = [...options.values()];
  const around = (days: number) => rows.filter(row => Math.abs((row.expiry - now) / 86_400_000 - days) <= Math.max(3, days * 0.35));
  const iv7 = weightedAverage(around(7));
  const iv30 = weightedAverage(around(30));
  const putIv = weightedAverage(rows.filter(row => row.delta >= -0.35 && row.delta <= -0.15));
  const callIv = weightedAverage(rows.filter(row => row.delta >= 0.15 && row.delta <= 0.35));
  return {
    btcIv7d: iv7,
    btcIv30d: iv30,
    btc25dSkew: putIv !== null && callIv !== null ? putIv - callIv : null,
    ivTermSlope: iv7 !== null && iv30 !== null ? iv30 - iv7 : null,
    optionContractsObserved: rows.length,
  };
}

export function getBtcMarketIntelligence(referencePrice: number, now = Date.now()): BtcMarketIntelligenceSnapshot {
  prune(now);
  const coinbaseImbalance = depthImbalance(coinbaseBook, referencePrice);
  const krakenImbalance = depthImbalance(krakenBook, referencePrice);
  const imbalances = [coinbaseImbalance, krakenImbalance].filter((value): value is number => value !== null);
  const age = (at: number | null) => at === null ? null : now - at;
  const blockers: string[] = [];
  if (age(coinbaseBook.updatedAt) === null || Number(age(coinbaseBook.updatedAt)) > 15_000) blockers.push('Coinbase L2 stale');
  if (age(krakenBook.updatedAt) === null || Number(age(krakenBook.updatedAt)) > 15_000) blockers.push('Kraken L2 stale');
  if (age(latestDeribitAt) === null || Number(age(latestDeribitAt)) > 15_000) blockers.push('Deribit stale');
  const delta = (venue: 'coinbase' | 'kraken') => trades.filter(row => row.venue === venue && row.at >= now - 10_000).reduce((sum, row) => sum + row.signedUsd, 0);
  return {
    generatedAt: now,
    healthy: blockers.length === 0,
    blockers,
    coinbaseDepthImbalance5Bps: coinbaseImbalance,
    krakenDepthImbalance5Bps: krakenImbalance,
    consolidatedSpotDepthImbalance5Bps: imbalances.length ? imbalances.reduce((sum, value) => sum + value, 0) / imbalances.length : null,
    coinbaseTradeDeltaUsd10s: delta('coinbase'),
    krakenTradeDeltaUsd10s: delta('kraken'),
    deribitPerpetualOpenInterest: deribitOpenInterest,
    deribitFundingRate,
    deribitBasisBps: deribitMark && deribitIndex ? (deribitMark - deribitIndex) / deribitIndex * 10_000 : null,
    ...optionMetrics(now),
    venueAgesMs: { coinbaseL2: age(coinbaseBook.updatedAt), krakenL2: age(krakenBook.updatedAt), deribit: age(latestDeribitAt) },
  };
}

export function startBtcMarketIntelligence(): void {
  if (started) return;
  started = true;
  connectCoinbase();
  connectKraken();
  connectDeribit();
  console.log('[btc] public Deribit, Coinbase L2, and Kraken L2 research feeds starting');
}
