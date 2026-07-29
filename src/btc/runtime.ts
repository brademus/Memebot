import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import WebSocket from 'ws';
import { pool } from '../db';
import {
  BTC_STRATEGY_VERSION,
  BtcCandle,
  BtcDirection,
  BtcFeedQuality,
  BtcImpulse,
  DEFAULT_BTC_STRATEGY_PARAMETERS,
  aggregateCandles,
  assessBtcRegime,
  detectBtcImpulse,
  evaluateBtcRetest,
} from './strategy';

type CallStatus = 'open' | 'won' | 'lost' | 'closed';
interface BtcCall {
  id: string; direction: BtcDirection; entry: number; stop: number; target: number;
  confidence: number; riskReward: number; status: CallStatus; openedAt: string;
  closedAt: string | null; exitPrice: number | null; exitReason: string | null;
  resultR: number | null; maxFavorableR: number; maxAdverseR: number;
  setup: Record<string, unknown>;
}

const PRODUCT = 'BTC-USD';
const INTERVALS = [60, 300, 900, 3600, 14_400] as const;
const enabled = process.env.BTC_SCANNER_ENABLED !== 'false';
const series = new Map<number, BtcCandle[]>(INTERVALS.map(value => [value, []]));
const sequences = new Map<string, number>();
let started = false;
let socket: WebSocket | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let reconnectAttempt = 0;
let coinbasePrice: number | null = null;
let krakenPrice: number | null = null;
let bestBid: number | null = null;
let bestAsk: number | null = null;
let coinbaseAt: number | null = null;
let krakenAt: number | null = null;
let sequenceGapAt: number | null = null;
let impulse: BtcImpulse | null = null;
let activeCall: BtcCall | null = null;
let recentCalls: BtcCall[] = [];
let engineState = enabled ? 'warming_up' : 'disabled';
let blockers: string[] = [];
let lastImpulseAt: number | null = null;
let cooldownUntil = 0;
let evaluation = Promise.resolve();
let dailyDate = '';
let dailyCalls = 0;
let dailyLosses = 0;

const n = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};
const list = (interval: number) => series.get(interval) || [];
const chicagoDate = () => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());

function resetDaily(): void {
  const date = chicagoDate();
  if (date === dailyDate) return;
  dailyDate = date; dailyCalls = 0; dailyLosses = 0;
}

function primarySession(at: number): boolean {
  const date = new Date(at);
  return date.getUTCDay() >= 1 && date.getUTCDay() <= 5 && date.getUTCHours() >= 12 && date.getUTCHours() < 21;
}

async function initializeSchema(): Promise<void> {
  if (!pool) return;
  const file = path.join(process.cwd(), 'schema-btc.sql');
  if (!fs.existsSync(file)) throw new Error('schema-btc.sql is missing');
  await pool.query(fs.readFileSync(file, 'utf8'));
}

async function history(interval: 60 | 300 | 900 | 3600): Promise<BtcCandle[]> {
  const response = await fetch(`https://api.exchange.coinbase.com/products/${PRODUCT}/candles?granularity=${interval}`, {
    headers: { Accept: 'application/json', 'User-Agent': 'Memebot-BTC-Paper/1.0' },
  });
  if (!response.ok) throw new Error(`Coinbase history ${interval}s returned ${response.status}`);
  const payload = await response.json() as unknown;
  if (!Array.isArray(payload)) throw new Error('Coinbase history payload is invalid');
  const now = Date.now();
  return payload.map((row): BtcCandle | null => {
    if (!Array.isArray(row) || row.length < 6) return null;
    const values = row.slice(0, 6).map(Number);
    if (!values.every(Number.isFinite)) return null;
    const [seconds, low, high, open, close, volume] = values;
    return { timeframeSec: interval, startMs: seconds * 1000, open, high, low, close, volume,
      tradeCount: 0, buyVolume: 0, sellVolume: 0, complete: seconds * 1000 + interval * 1000 <= now - 2000 };
  }).filter((row): row is BtcCandle => row !== null).sort((a, b) => a.startMs - b.startMs);
}

async function warm(): Promise<void> {
  const [m1, m5, m15, h1] = await Promise.all([history(60), history(300), history(900), history(3600)]);
  series.set(60, m1); series.set(300, m5); series.set(900, m15); series.set(3600, h1);
  series.set(14_400, aggregateCandles(h1, 14_400).map(candle => ({
    ...candle, complete: candle.startMs + 14_400_000 <= Date.now() - 2000,
  })));
}

function updateCandle(interval: number, price: number, size: number, at: number, direction: BtcDirection): boolean {
  const candles = list(interval);
  const startMs = Math.floor(at / (interval * 1000)) * interval * 1000;
  let candle = candles.at(-1);
  let closed = false;
  if (!candle || candle.startMs !== startMs) {
    if (candle && candle.startMs < startMs) { candle.complete = true; closed = true; }
    candle = { timeframeSec: interval, startMs, open: price, high: price, low: price, close: price,
      volume: 0, tradeCount: 0, buyVolume: 0, sellVolume: 0, complete: false };
    candles.push(candle);
    if (candles.length > 2500) candles.splice(0, candles.length - 2500);
  }
  candle.high = Math.max(candle.high, price); candle.low = Math.min(candle.low, price); candle.close = price;
  candle.volume += size; candle.tradeCount++;
  if (direction === 'long') candle.buyVolume += size; else candle.sellVolume += size;
  return closed;
}

function callR(call: BtcCall, price: number): number {
  const risk = Math.abs(call.entry - call.stop);
  return call.direction === 'long' ? (price - call.entry) / risk : (call.entry - price) / risk;
}

async function closeCall(price: number, reason: string, at: number): Promise<void> {
  const call = activeCall;
  if (!call) return;
  call.resultR = callR(call, price);
  call.status = call.resultR > 0 ? 'won' : call.resultR < 0 ? 'lost' : 'closed';
  call.closedAt = new Date(at).toISOString(); call.exitPrice = price; call.exitReason = reason;
  if (call.status === 'lost') dailyLosses++;
  activeCall = null; cooldownUntil = at + 30 * 60_000; engineState = 'cooldown';
  if (pool) await pool.query(`UPDATE btc_calls SET status=$2,closed_at=to_timestamp($3/1000.0),exit_price=$4,
    exit_reason=$5,result_r=$6,max_favorable_r=$7,max_adverse_r=$8,updated_at=now() WHERE id=$1`,
    [call.id, call.status, at, price, reason, call.resultR, call.maxFavorableR, call.maxAdverseR]);
}

function monitorCall(price: number, at: number): void {
  const call = activeCall;
  if (!call) return;
  const r = callR(call, price);
  call.maxFavorableR = Math.max(call.maxFavorableR, r); call.maxAdverseR = Math.min(call.maxAdverseR, r);
  const stop = call.direction === 'long' ? price <= call.stop : price >= call.stop;
  const target = call.direction === 'long' ? price >= call.target : price <= call.target;
  if (stop) void closeCall(price, 'stop', at);
  else if (target) void closeCall(price, 'target_2_5r', at);
  else if (at - Date.parse(call.openedAt) >= 8 * 60 * 60_000) void closeCall(price, 'eight_hour_time_exit', at);
}

function onTrade(price: number, size: number, at: number, makerSide: string): void {
  coinbasePrice = price; coinbaseAt = Date.now();
  const direction: BtcDirection = makerSide.toUpperCase() === 'BUY' ? 'short' : 'long';
  let evaluate = false;
  for (const interval of INTERVALS) if (updateCandle(interval, price, size, at, direction) && interval >= 300) evaluate = true;
  monitorCall(price, at);
  if (evaluate) evaluation = evaluation.then(() => evaluateStrategy(at)).catch(error => console.error('[btc]', (error as Error).message));
}

function parse(raw: WebSocket.RawData): void {
  let message: any;
  try { message = JSON.parse(raw.toString()); } catch { return; }
  const channel = String(message.channel || 'unknown');
  if (Number.isInteger(message.sequence_num)) {
    const previous = sequences.get(channel);
    if (previous !== undefined && message.sequence_num > previous + 1) sequenceGapAt = Date.now();
    sequences.set(channel, Math.max(previous || 0, message.sequence_num));
  }
  if (message.channel === 'ticker') for (const event of message.events || []) for (const ticker of event.tickers || []) {
    coinbasePrice = n(ticker.price) ?? coinbasePrice; bestBid = n(ticker.best_bid) ?? bestBid; bestAsk = n(ticker.best_ask) ?? bestAsk;
    coinbaseAt = Date.now();
  }
  if (message.channel === 'market_trades') for (const event of message.events || []) for (const trade of event.trades || []) {
    const price = n(trade.price); const size = n(trade.size); const at = Date.parse(String(trade.time || message.timestamp || ''));
    if (price && size && Number.isFinite(at)) onTrade(price, size, at, String(trade.side || ''));
  }
}

function connect(): void {
  if (!enabled) return;
  const ws = new WebSocket('wss://advanced-trade-ws.coinbase.com'); socket = ws;
  ws.on('open', () => {
    reconnectAttempt = 0;
    for (const channel of ['heartbeats', 'ticker', 'market_trades']) {
      ws.send(JSON.stringify({ type: 'subscribe', channel, ...(channel === 'heartbeats' ? {} : { product_ids: [PRODUCT] }) }));
    }
  });
  ws.on('message', parse);
  ws.on('error', () => ws.close());
  ws.on('close', () => {
    if (socket === ws) socket = null;
    if (reconnectTimer) return;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(reconnectAttempt++, 5));
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, delay);
  });
}

async function pollKraken(): Promise<void> {
  try {
    const response = await fetch('https://api.kraken.com/0/public/Ticker?pair=XBTUSD');
    const payload = await response.json() as any;
    const row = Object.values(payload?.result || {})[0] as any;
    krakenPrice = n(row?.c?.[0]); krakenAt = krakenPrice ? Date.now() : krakenAt;
  } catch {}
}

function quality(now = Date.now()): BtcFeedQuality {
  const coinbaseAgeMs = coinbaseAt === null ? null : now - coinbaseAt;
  const krakenAgeMs = krakenAt === null ? null : now - krakenAt;
  const spreadBps = bestBid && bestAsk ? ((bestAsk - bestBid) / ((bestAsk + bestBid) / 2)) * 10_000 : null;
  const divergenceBps = coinbasePrice && krakenPrice ? Math.abs(coinbasePrice - krakenPrice) / ((coinbasePrice + krakenPrice) / 2) * 10_000 : null;
  const recentSequenceGap = sequenceGapAt !== null && now - sequenceGapAt < 60_000;
  const reasons: string[] = [];
  if (coinbaseAgeMs === null || coinbaseAgeMs > 10_000) reasons.push('Coinbase price feed is stale');
  if (krakenAgeMs === null || krakenAgeMs > 45_000) reasons.push('Kraken validation price is stale');
  if (spreadBps === null || spreadBps > DEFAULT_BTC_STRATEGY_PARAMETERS.maxSpreadBps) reasons.push('Coinbase spread is abnormal');
  if (divergenceBps === null || divergenceBps > DEFAULT_BTC_STRATEGY_PARAMETERS.maxDivergenceBps) reasons.push('Coinbase and Kraken prices disagree');
  if (recentSequenceGap) reasons.push('a recent Coinbase sequence gap was detected');
  return { healthy: reasons.length === 0, coinbaseAgeMs, krakenAgeMs, spreadBps, divergenceBps, recentSequenceGap, blockers: reasons };
}

async function createCall(decision: ReturnType<typeof evaluateBtcRetest>, source: BtcImpulse, at: number): Promise<void> {
  if (!decision.ready || decision.entry === null || decision.stop === null || decision.target === null) return;
  const call: BtcCall = { id: crypto.randomUUID(), direction: decision.direction, entry: decision.entry,
    stop: decision.stop, target: decision.target, confidence: decision.confidence, riskReward: decision.riskReward,
    status: 'open', openedAt: new Date(at).toISOString(), closedAt: null, exitPrice: null, exitReason: null,
    resultR: null, maxFavorableR: 0, maxAdverseR: 0, setup: { paperOnly: true, impulse: source, flowRatio: decision.flowRatio } };
  if (pool) await pool.query(`INSERT INTO btc_calls
    (id,strategy_version,direction,entry_price,stop_price,target_price,confidence,risk_reward,status,opened_at,setup)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'open',to_timestamp($9/1000.0),$10)`,
    [call.id, BTC_STRATEGY_VERSION, call.direction, call.entry, call.stop, call.target, call.confidence, call.riskReward, at, JSON.stringify(call.setup)]);
  activeCall = call; recentCalls.unshift(call); recentCalls = recentCalls.slice(0, 50); dailyCalls++; impulse = null; engineState = 'call_active'; blockers = [];
}

async function evaluateStrategy(now: number): Promise<void> {
  resetDaily();
  if (activeCall) { engineState = 'call_active'; return; }
  if (now < cooldownUntil) { engineState = 'cooldown'; blockers = ['post-call cooldown is active']; return; }
  if (dailyCalls >= 2 || dailyLosses >= 2) { engineState = 'daily_limit'; blockers = ['daily BTC call circuit breaker is active']; return; }
  if (!primarySession(now)) { engineState = 'outside_session'; blockers = ['waiting for weekdays 12:00-21:00 UTC']; return; }
  const feed = quality(now);
  if (!feed.healthy) { engineState = 'feed_blocked'; blockers = feed.blockers; return; }
  const regime = assessBtcRegime(list(3600), list(14_400), list(900));
  if (!regime.direction) { impulse = null; engineState = 'no_setup'; blockers = regime.blockers; return; }
  if (impulse) {
    const decision = evaluateBtcRetest(impulse, list(300), feed, now);
    impulse = decision.nextImpulse;
    if (decision.ready && impulse) await createCall(decision, impulse, now);
    else { engineState = impulse ? 'waiting_for_retest' : 'no_setup'; blockers = decision.blockers; }
    return;
  }
  const latest = list(900).filter(candle => candle.complete).at(-1);
  if (!latest || latest.startMs === lastImpulseAt) { engineState = 'no_setup'; blockers = ['waiting for the next fifteen-minute candle']; return; }
  lastImpulseAt = latest.startMs;
  const result = detectBtcImpulse(list(900), regime, now);
  impulse = result.impulse; engineState = impulse ? 'waiting_for_retest' : 'no_setup';
  blockers = impulse ? ['qualified impulse found; waiting for a controlled retest'] : result.blockers;
}

function fromRow(row: any): BtcCall {
  return { id: row.id, direction: row.direction, entry: Number(row.entry_price), stop: Number(row.stop_price),
    target: Number(row.target_price), confidence: Number(row.confidence), riskReward: Number(row.risk_reward),
    status: row.status, openedAt: new Date(row.opened_at).toISOString(), closedAt: row.closed_at ? new Date(row.closed_at).toISOString() : null,
    exitPrice: row.exit_price === null ? null : Number(row.exit_price), exitReason: row.exit_reason,
    resultR: row.result_r === null ? null : Number(row.result_r), maxFavorableR: Number(row.max_favorable_r || 0),
    maxAdverseR: Number(row.max_adverse_r || 0), setup: row.setup || {} };
}

async function hydrate(): Promise<void> {
  if (!pool) return;
  const result = await pool.query('SELECT * FROM btc_calls ORDER BY opened_at DESC LIMIT 50');
  recentCalls = result.rows.map(fromRow); activeCall = recentCalls.find(call => call.status === 'open') || null;
}

export async function startBtcPaperEngine(): Promise<void> {
  if (started) return; started = true;
  if (!enabled) return;
  await initializeSchema();
  try { await warm(); } catch (error) { console.error('[btc] warmup:', (error as Error).message); }
  await hydrate(); await pollKraken(); connect();
  const poll = setInterval(() => void pollKraken(), 15_000); poll.unref();
  const scan = setInterval(() => { evaluation = evaluation.then(() => evaluateStrategy(Date.now())).catch(() => {}); }, 60_000); scan.unref();
  engineState = activeCall ? 'call_active' : 'warming_up';
  console.log('[btc] paper-only BTC strategy engine started');
}

function publicCall(call: BtcCall | null): Record<string, unknown> | null {
  if (!call) return null;
  return { ...call, strategyVersion: BTC_STRATEGY_VERSION, currentPrice: coinbasePrice,
    currentR: coinbasePrice ? callR(call, coinbasePrice) : null, paperOnly: true };
}

export async function getBtcStatus(): Promise<Record<string, unknown>> {
  resetDaily();
  return { market: PRODUCT, mode: 'paper', enabled, strategyVersion: BTC_STRATEGY_VERSION,
    strategyName: 'Regime-Filtered High-Volume Momentum Retest', engineState, price: coinbasePrice,
    validationPrice: krakenPrice, feed: quality(), session: { active: primarySession(Date.now()), window: 'Weekdays 12:00-21:00 UTC' },
    limits: { dailyCalls, dailyLosses, maxCalls: 2, maxLosses: 2 }, warmup: { m1: list(60).length, m5: list(300).length,
      m15: list(900).length, h1: list(3600).length, h4: list(14_400).length }, setup: impulse, blockers,
    activeCall: publicCall(activeCall), recentCalls: recentCalls.slice(0, 12).map(call => publicCall(call)), updatedAt: new Date().toISOString() };
}
