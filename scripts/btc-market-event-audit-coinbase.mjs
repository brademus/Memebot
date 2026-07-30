import fs from 'node:fs/promises';

const MEMEBOT_URL = process.env.MEMEBOT_AUDIT_URL || 'https://memebot-olive.vercel.app/api/calls';
const COINBASE_CANDLES = 'https://api.exchange.coinbase.com/products/BTC-USD/candles';
const MINUTE = 60_000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const finite = values => values.filter(Number.isFinite);
const mean = values => {
  const sample = finite(values);
  return sample.length ? sample.reduce((sum, value) => sum + value, 0) / sample.length : null;
};
const median = values => {
  const sample = finite(values).sort((a, b) => a - b);
  if (!sample.length) return null;
  const middle = Math.floor(sample.length / 2);
  return sample.length % 2 ? sample[middle] : (sample[middle - 1] + sample[middle]) / 2;
};
const round = (value, digits = 4) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
const pct = (from, to) => from > 0 && to > 0 ? (to / from - 1) * 100 : null;

async function fetchJson(url, attempts = 4) {
  let failure;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { Accept: 'application/json', 'User-Agent': 'Memebot-BTC-Market-Audit/1.0' },
      });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return await response.json();
    } catch (error) {
      failure = error;
      if (attempt < attempts) await sleep(attempt * 750);
    }
  }
  throw failure;
}

async function fetchCoinbaseCandles(startMs, endMs) {
  const byStart = new Map();
  const chunkMs = 250 * MINUTE;
  for (let cursor = startMs; cursor <= endMs; cursor += chunkMs) {
    const chunkEnd = Math.min(endMs, cursor + chunkMs - MINUTE);
    const query = new URLSearchParams({
      granularity: '60',
      start: new Date(cursor).toISOString(),
      end: new Date(chunkEnd).toISOString(),
    });
    const rows = await fetchJson(`${COINBASE_CANDLES}?${query}`);
    if (!Array.isArray(rows)) throw new Error('Coinbase candle payload was not an array');
    for (const row of rows) {
      if (!Array.isArray(row) || row.length < 6) continue;
      const candle = {
        startMs: Number(row[0]) * 1000,
        low: Number(row[1]), high: Number(row[2]), open: Number(row[3]),
        close: Number(row[4]), volume: Number(row[5]),
      };
      if (Object.values(candle).every(Number.isFinite)) byStart.set(candle.startMs, candle);
    }
    await sleep(180);
  }
  return [...byStart.values()].sort((a, b) => a.startMs - b.startMs);
}

function atr(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const sample = candles.slice(-(period + 1));
  const ranges = [];
  for (let index = 1; index < sample.length; index++) {
    const candle = sample[index];
    const previous = sample[index - 1];
    ranges.push(Math.max(candle.high - candle.low, Math.abs(candle.high - previous.close), Math.abs(candle.low - previous.close)));
  }
  return mean(ranges);
}

function efficiency(candles) {
  if (candles.length < 3) return null;
  const net = Math.abs(candles.at(-1).close - candles[0].close);
  const path = candles.slice(1).reduce((sum, candle, index) => sum + Math.abs(candle.close - candles[index].close), 0);
  return path > 0 ? net / path : 0;
}

function priceAt(candles, timestamp) {
  let selected = null;
  for (const candle of candles) {
    if (candle.startMs > timestamp) break;
    selected = candle.close;
  }
  return selected;
}

function directionalReturn(direction, entry, price) {
  const raw = pct(entry, price);
  if (raw === null) return null;
  return direction === 'long' ? raw : -raw;
}

function analyze(call, candles) {
  const openedAt = Number(call.openedAt);
  const expectedMinutes = Number(call.features?.expectedHoldingMinutes || 240);
  const closedAt = Number(call.closedAt || openedAt + expectedMinutes * MINUTE);
  const entry = Number(call.entryPrice);
  const stop = Number(call.stopPrice);
  const target = Number(call.targetPrice);
  const prior = candles.filter(candle => candle.startMs < openedAt);
  const prior60 = prior.slice(-60);
  const prior30 = prior.slice(-30);
  const post = candles.filter(candle => candle.startMs >= Math.floor(openedAt / MINUTE) * MINUTE && candle.startMs <= closedAt);
  const localAtr = atr(prior, 14);
  const stopDistancePct = Math.abs(entry - stop) / entry * 100;
  const targetDistancePct = Math.abs(target - entry) / entry * 100;
  const grossRiskUsd = Number(call.notionalUsd) * stopDistancePct / 100;
  const costs = Number(call.features?.totalModeledCostsUsd ?? call.feesUsd ?? 0);
  const before = minutes => {
    const price = priceAt(candles, openedAt - minutes * MINUTE);
    return price ? pct(price, entry) : null;
  };
  const after = minutes => {
    const price = priceAt(candles, openedAt + minutes * MINUTE);
    return price ? directionalReturn(call.direction, entry, price) : null;
  };
  let mfePct = 0;
  let maePct = 0;
  let timeToMfeMin = null;
  let timeToMaeMin = null;
  for (const candle of post) {
    const favorablePrice = call.direction === 'long' ? candle.high : candle.low;
    const adversePrice = call.direction === 'long' ? candle.low : candle.high;
    const favorable = directionalReturn(call.direction, entry, favorablePrice);
    const adverse = directionalReturn(call.direction, entry, adversePrice);
    if (Number.isFinite(favorable) && favorable > mfePct) {
      mfePct = favorable;
      timeToMfeMin = (candle.startMs - openedAt) / MINUTE;
    }
    if (Number.isFinite(adverse) && adverse < maePct) {
      maePct = adverse;
      timeToMaeMin = (candle.startMs - openedAt) / MINUTE;
    }
  }
  const low60 = prior60.length ? Math.min(...prior60.map(candle => candle.low)) : null;
  const high60 = prior60.length ? Math.max(...prior60.map(candle => candle.high)) : null;
  const rangePosition = low60 !== null && high60 > low60 ? (entry - low60) / (high60 - low60) : null;
  const prior60Return = before(60);
  const efficiency30 = efficiency(prior30);
  const marketState = efficiency30 !== null && efficiency30 >= 0.42 && Math.abs(prior60Return || 0) >= 0.25
    ? (prior60Return > 0 ? 'trend_up' : 'trend_down') : 'chop_or_transition';
  const post5 = after(5);
  return {
    id: call.id,
    strategyId: call.strategyId,
    strategyVersion: call.strategyVersion,
    strategyName: call.strategyName,
    direction: call.direction,
    status: call.status,
    openedAt: new Date(openedAt).toISOString(),
    closedAt: call.closedAt ? new Date(Number(call.closedAt)).toISOString() : null,
    holdingMinutes: round((closedAt - openedAt) / MINUTE, 2),
    entryPrice: entry,
    leverage: Number(call.leverage),
    resultR: round(Number(call.resultR), 4),
    netPnlUsd: round(Number(call.netPnlUsd), 4),
    stopDistancePct: round(stopDistancePct, 4),
    targetDistancePct: round(targetDistancePct, 4),
    rawTargetRR: round(targetDistancePct / Math.max(stopDistancePct, 1e-9), 3),
    modeledCostUsd: round(costs, 4),
    modeledCostToGrossRiskPct: round(grossRiskUsd > 0 ? costs / grossRiskUsd * 100 : null, 2),
    priorReturn5Pct: round(before(5), 4),
    priorReturn15Pct: round(before(15), 4),
    priorReturn30Pct: round(before(30), 4),
    priorReturn60Pct: round(prior60Return, 4),
    priorEfficiency30: round(efficiency30, 4),
    priorAtr14Pct: round(localAtr ? localAtr / entry * 100 : null, 4),
    priorRangePosition60: round(rangePosition, 4),
    marketState,
    postDirectional5Pct: round(post5, 4),
    postDirectional15Pct: round(after(15), 4),
    postDirectional30Pct: round(after(30), 4),
    postDirectional60Pct: round(after(60), 4),
    pathMfePct: round(mfePct, 4),
    pathMaePct: round(maePct, 4),
    timeToMfeMin: round(timeToMfeMin, 2),
    timeToMaeMin: round(timeToMaeMin, 2),
    immediateAdverse5m: Number.isFinite(post5) ? post5 < 0 : null,
    stoppedBeforeHalfR: Math.abs(maePct) >= stopDistancePct && mfePct < stopDistancePct * 0.5,
    features: call.features || {},
  };
}

function summarize(trades) {
  const groups = new Map();
  for (const trade of trades) {
    const key = `${trade.strategyId}@${trade.strategyVersion}`;
    groups.set(key, [...(groups.get(key) || []), trade]);
  }
  return [...groups.entries()].map(([strategy, sample]) => ({
    strategy,
    trades: sample.length,
    wins: sample.filter(trade => trade.status === 'won').length,
    losses: sample.filter(trade => ['lost', 'liquidated'].includes(trade.status)).length,
    averageR: round(mean(sample.map(trade => trade.resultR)), 4),
    medianR: round(median(sample.map(trade => trade.resultR)), 4),
    averageMfePct: round(mean(sample.map(trade => trade.pathMfePct)), 4),
    averageMaePct: round(mean(sample.map(trade => trade.pathMaePct)), 4),
    immediateAdverseRatePct: round(mean(sample.map(trade => trade.immediateAdverse5m === null ? null : Number(trade.immediateAdverse5m))) * 100, 1),
    stoppedBeforeHalfRRatePct: round(mean(sample.map(trade => Number(trade.stoppedBeforeHalfR))) * 100, 1),
    averageCostToGrossRiskPct: round(mean(sample.map(trade => trade.modeledCostToGrossRiskPct)), 2),
    averagePriorReturn15Pct: round(mean(sample.map(trade => trade.priorReturn15Pct)), 4),
    averagePriorEfficiency30: round(mean(sample.map(trade => trade.priorEfficiency30)), 4),
    averageRangePosition60: round(mean(sample.map(trade => trade.priorRangePosition60)), 4),
    longTrades: sample.filter(trade => trade.direction === 'long').length,
    shortTrades: sample.filter(trade => trade.direction === 'short').length,
    marketStates: Object.fromEntries([...new Set(sample.map(trade => trade.marketState))].map(state => [state, sample.filter(trade => trade.marketState === state).length])),
  })).sort((a, b) => b.trades - a.trades);
}

function markdown(report) {
  const lines = [
    '# BTC Market Event Audit', '',
    `Generated: ${report.generatedAt}`,
    `Market candle source: ${report.marketSource}`,
    `Resolved calls analyzed: ${report.resolvedCalls}`,
    `Candle range: ${report.candleStart} to ${report.candleEnd}`, '',
    '| Strategy version | Trades | W-L | Avg R | Avg MFE % | Avg MAE % | Adverse in 5m | Stop before 0.5R | Cost / gross risk | Market states |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---|',
  ];
  for (const row of report.byStrategy) {
    lines.push(`| ${row.strategy} | ${row.trades} | ${row.wins}-${row.losses} | ${row.averageR ?? 'n/a'} | ${row.averageMfePct ?? 'n/a'} | ${row.averageMaePct ?? 'n/a'} | ${row.immediateAdverseRatePct ?? 'n/a'}% | ${row.stoppedBeforeHalfRRatePct ?? 'n/a'}% | ${row.averageCostToGrossRiskPct ?? 'n/a'}% | ${Object.entries(row.marketStates).map(([state, count]) => `${state}:${count}`).join(', ')} |`);
  }
  lines.push('', '## Per-trade diagnostics', '');
  for (const trade of report.trades) {
    lines.push(`- **${trade.strategyId}@${trade.strategyVersion} ${trade.direction} ${trade.status}** — ${trade.openedAt}; R ${trade.resultR}; prior 15m ${trade.priorReturn15Pct}%; range position ${trade.priorRangePosition60}; 5m directional ${trade.postDirectional5Pct}%; MFE ${trade.pathMfePct}%; MAE ${trade.pathMaePct}%; costs ${trade.modeledCostToGrossRiskPct}% of gross stop risk.`);
  }
  return `${lines.join('\n')}\n`;
}

const payload = await fetchJson(MEMEBOT_URL);
const btc = payload?.btc || payload;
const calls = Array.isArray(btc?.recentCalls) ? btc.recentCalls : [];
const resolved = calls.filter(call => call?.closedAt && ['won', 'lost', 'closed', 'liquidated'].includes(call.status));
if (!resolved.length) throw new Error('No resolved BTC calls were returned by the live Memebot endpoint');
const earliest = Math.min(...resolved.map(call => Number(call.openedAt))) - 120 * MINUTE;
const latest = Math.max(...resolved.map(call => Number(call.closedAt))) + 120 * MINUTE;
const candles = await fetchCoinbaseCandles(earliest, latest);
if (!candles.length) throw new Error('No Coinbase BTC-USD candles were returned for the audit window');
const trades = resolved.map(call => analyze(call, candles));
const report = {
  generatedAt: new Date().toISOString(),
  source: MEMEBOT_URL,
  marketSource: 'Coinbase BTC-USD one-minute candles; Bybit entry/exit ledger remains source of trade fills',
  resolvedCalls: trades.length,
  candleStart: new Date(candles[0].startMs).toISOString(),
  candleEnd: new Date(candles.at(-1).startMs).toISOString(),
  byStrategy: summarize(trades),
  trades,
};
await fs.mkdir('artifacts', { recursive: true });
await fs.writeFile('artifacts/btc-market-audit.json', JSON.stringify(report, null, 2));
await fs.writeFile('artifacts/btc-market-audit.md', markdown(report));
console.log(markdown(report));
