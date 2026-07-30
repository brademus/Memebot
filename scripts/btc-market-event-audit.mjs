import fs from 'node:fs/promises';

const MEMEBOT_URL = process.env.MEMEBOT_AUDIT_URL || 'https://memebot-olive.vercel.app/api/calls';
const BYBIT_KLINE = 'https://api.bybit.com/v5/market/kline';
const minute = 60_000;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const median = values => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const round = (value, digits = 4) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
const pct = (from, to) => from > 0 && to > 0 ? (to / from - 1) * 100 : null;

async function fetchJson(url, attempts = 5) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { Accept: 'application/json', 'User-Agent': 'Memebot-BTC-Market-Audit/1.0' },
      });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(attempt * 1_000);
    }
  }
  throw lastError;
}

async function fetchMinuteCandles(startMs, endMs) {
  const byStart = new Map();
  const chunk = 900 * minute;
  for (let cursor = startMs; cursor <= endMs; cursor += chunk) {
    const chunkEnd = Math.min(endMs, cursor + chunk - minute);
    const query = new URLSearchParams({
      category: 'linear', symbol: 'BTCUSDT', interval: '1',
      start: String(cursor), end: String(chunkEnd), limit: '1000',
    });
    const payload = await fetchJson(`${BYBIT_KLINE}?${query}`);
    if (Number(payload?.retCode) !== 0 || !Array.isArray(payload?.result?.list)) {
      throw new Error(`Bybit kline payload invalid: ${JSON.stringify(payload).slice(0, 240)}`);
    }
    for (const row of payload.result.list) {
      const candle = {
        startMs: Number(row[0]), open: Number(row[1]), high: Number(row[2]),
        low: Number(row[3]), close: Number(row[4]), volume: Number(row[5]),
      };
      if (Object.values(candle).every(Number.isFinite)) byStart.set(candle.startMs, candle);
    }
    await sleep(120);
  }
  return [...byStart.values()].sort((a, b) => a.startMs - b.startMs);
}

function trueRange(current, previous) {
  if (!previous) return current.high - current.low;
  return Math.max(current.high - current.low, Math.abs(current.high - previous.close), Math.abs(current.low - previous.close));
}

function atr(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const sample = candles.slice(-(period + 1));
  return mean(sample.slice(1).map((candle, index) => trueRange(candle, sample[index])));
}

function efficiency(candles) {
  if (candles.length < 3) return null;
  const net = Math.abs(candles.at(-1).close - candles[0].close);
  const path = candles.slice(1).reduce((sum, candle, index) => sum + Math.abs(candle.close - candles[index].close), 0);
  return path > 0 ? net / path : 0;
}

function priceAtOrBefore(candles, timestamp) {
  const eligible = candles.filter(candle => candle.startMs <= timestamp);
  return eligible.at(-1)?.close ?? null;
}

function directionalReturn(direction, entry, price) {
  const raw = pct(entry, price);
  return raw === null ? null : direction === 'long' ? raw : -raw;
}

function analyzeCall(call, candles) {
  const openedAt = Number(call.openedAt);
  const closedAt = Number(call.closedAt || openedAt + Number(call.features?.expectedHoldingMinutes || 240) * minute);
  const entry = Number(call.entryPrice);
  const direction = call.direction;
  const prior = candles.filter(candle => candle.startMs < openedAt);
  const prior60 = prior.slice(-60);
  const prior30 = prior.slice(-30);
  const localAtr = atr(prior, 14);
  const post = candles.filter(candle => candle.startMs >= Math.floor(openedAt / minute) * minute && candle.startMs <= closedAt);
  const stopDistancePct = Math.abs(entry - Number(call.stopPrice)) / entry * 100;
  const targetDistancePct = Math.abs(Number(call.targetPrice) - entry) / entry * 100;
  const grossRiskUsd = Number(call.notionalUsd) * stopDistancePct / 100;
  const totalModeledCosts = Number(call.features?.totalModeledCostsUsd ?? call.feesUsd ?? 0);

  let mfePct = 0;
  let maePct = 0;
  let timeToMfeMin = null;
  let timeToMaeMin = null;
  for (const candle of post) {
    const favorable = direction === 'long' ? pct(entry, candle.high) : pct(candle.low, entry);
    const adverse = direction === 'long' ? pct(entry, candle.low) : pct(candle.high, entry);
    if (Number.isFinite(favorable) && favorable > mfePct) {
      mfePct = favorable;
      timeToMfeMin = (candle.startMs - openedAt) / minute;
    }
    const signedAdverse = Number.isFinite(adverse) ? -Math.abs(adverse) : 0;
    if (signedAdverse < maePct) {
      maePct = signedAdverse;
      timeToMaeMin = (candle.startMs - openedAt) / minute;
    }
  }

  const priorLow = prior60.length ? Math.min(...prior60.map(candle => candle.low)) : null;
  const priorHigh = prior60.length ? Math.max(...prior60.map(candle => candle.high)) : null;
  const rangePosition = priorLow !== null && priorHigh > priorLow ? (entry - priorLow) / (priorHigh - priorLow) : null;
  const returnFor = minutes => {
    const price = priceAtOrBefore(candles, openedAt - minutes * minute);
    return price ? pct(price, entry) : null;
  };
  const afterFor = minutes => {
    const price = priceAtOrBefore(candles, openedAt + minutes * minute);
    return price ? directionalReturn(direction, entry, price) : null;
  };
  const priorReturn60 = returnFor(60);
  const priorEfficiency30 = efficiency(prior30);
  const marketState = priorEfficiency30 !== null && priorEfficiency30 >= 0.42 && Math.abs(priorReturn60 || 0) >= 0.25
    ? (priorReturn60 > 0 ? 'trend_up' : 'trend_down') : 'chop_or_transition';

  return {
    id: call.id,
    strategyId: call.strategyId,
    strategyVersion: call.strategyVersion,
    strategyName: call.strategyName,
    direction,
    status: call.status,
    openedAt: new Date(openedAt).toISOString(),
    closedAt: call.closedAt ? new Date(Number(call.closedAt)).toISOString() : null,
    holdingMinutes: round((closedAt - openedAt) / minute, 2),
    entryPrice: entry,
    resultR: round(Number(call.resultR), 4),
    netPnlUsd: round(Number(call.netPnlUsd), 4),
    leverage: Number(call.leverage),
    stopDistancePct: round(stopDistancePct, 4),
    targetDistancePct: round(targetDistancePct, 4),
    rawTargetRR: round(targetDistancePct / Math.max(stopDistancePct, 1e-9), 3),
    modeledCostUsd: round(totalModeledCosts, 4),
    modeledCostToGrossRiskPct: round(grossRiskUsd > 0 ? totalModeledCosts / grossRiskUsd * 100 : null, 2),
    priorReturn5Pct: round(returnFor(5), 4),
    priorReturn15Pct: round(returnFor(15), 4),
    priorReturn30Pct: round(returnFor(30), 4),
    priorReturn60Pct: round(priorReturn60, 4),
    priorEfficiency30: round(priorEfficiency30, 4),
    priorAtr14Pct: round(localAtr ? localAtr / entry * 100 : null, 4),
    priorRangePosition60: round(rangePosition, 4),
    marketState,
    postDirectional5Pct: round(afterFor(5), 4),
    postDirectional15Pct: round(afterFor(15), 4),
    postDirectional30Pct: round(afterFor(30), 4),
    postDirectional60Pct: round(afterFor(60), 4),
    pathMfePct: round(mfePct, 4),
    pathMaePct: round(maePct, 4),
    timeToMfeMin: round(timeToMfeMin, 2),
    timeToMaeMin: round(timeToMaeMin, 2),
    immediateAdverse5m: Number.isFinite(afterFor(5)) ? afterFor(5) < 0 : null,
    stoppedBeforeHalfR: Math.abs(maePct) >= stopDistancePct && mfePct < stopDistancePct * 0.5,
    features: call.features || {},
  };
}

function aggregate(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.strategyId}@${row.strategyVersion}`;
    const group = groups.get(key) || [];
    group.push(row);
    groups.set(key, group);
  }
  return [...groups.entries()].map(([strategy, sample]) => ({
    strategy,
    trades: sample.length,
    wins: sample.filter(row => row.status === 'won').length,
    losses: sample.filter(row => ['lost', 'liquidated'].includes(row.status)).length,
    averageR: round(mean(sample.map(row => row.resultR).filter(Number.isFinite)), 4),
    medianR: round(median(sample.map(row => row.resultR).filter(Number.isFinite)), 4),
    averageMfePct: round(mean(sample.map(row => row.pathMfePct).filter(Number.isFinite)), 4),
    averageMaePct: round(mean(sample.map(row => row.pathMaePct).filter(Number.isFinite)), 4),
    immediateAdverseRatePct: round(mean(sample.map(row => row.immediateAdverse5m === null ? null : Number(row.immediateAdverse5m)).filter(Number.isFinite)) * 100, 1),
    stoppedBeforeHalfRRatePct: round(mean(sample.map(row => Number(row.stoppedBeforeHalfR))) * 100, 1),
    averageCostToGrossRiskPct: round(mean(sample.map(row => row.modeledCostToGrossRiskPct).filter(Number.isFinite)), 2),
    averagePriorReturn15Pct: round(mean(sample.map(row => row.priorReturn15Pct).filter(Number.isFinite)), 4),
    averagePriorEfficiency30: round(mean(sample.map(row => row.priorEfficiency30).filter(Number.isFinite)), 4),
    averageRangePosition60: round(mean(sample.map(row => row.priorRangePosition60).filter(Number.isFinite)), 4),
    marketStates: Object.fromEntries([...new Set(sample.map(row => row.marketState))].map(state => [state, sample.filter(row => row.marketState === state).length])),
    longTrades: sample.filter(row => row.direction === 'long').length,
    shortTrades: sample.filter(row => row.direction === 'short').length,
  })).sort((a, b) => b.trades - a.trades);
}

function markdown(report) {
  const lines = [
    '# BTC Market Event Audit',
    '',
    `Generated: ${report.generatedAt}`,
    `Resolved calls analyzed: ${report.resolvedCalls}`,
    `Candle range: ${report.candleStart} to ${report.candleEnd}`,
    '',
    '| Strategy version | Trades | W-L | Avg R | Avg MFE % | Avg MAE % | Adverse in 5m | Stop before 0.5R | Cost / gross risk | Market states |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---|',
  ];
  for (const row of report.byStrategy) {
    lines.push(`| ${row.strategy} | ${row.trades} | ${row.wins}-${row.losses} | ${row.averageR ?? 'n/a'} | ${row.averageMfePct ?? 'n/a'} | ${row.averageMaePct ?? 'n/a'} | ${row.immediateAdverseRatePct ?? 'n/a'}% | ${row.stoppedBeforeHalfRRatePct ?? 'n/a'}% | ${row.averageCostToGrossRiskPct ?? 'n/a'}% | ${Object.entries(row.marketStates).map(([state, count]) => `${state}:${count}`).join(', ')} |`);
  }
  lines.push('', '## Per-trade diagnostics', '');
  for (const row of report.trades) {
    lines.push(`- **${row.strategyId}@${row.strategyVersion} ${row.direction} ${row.status}** — ${row.openedAt}; R ${row.resultR}; prior 15m ${row.priorReturn15Pct}%; range position ${row.priorRangePosition60}; 5m directional ${row.postDirectional5Pct}%; MFE ${row.pathMfePct}%; MAE ${row.pathMaePct}%; costs ${row.modeledCostToGrossRiskPct}% of gross stop risk.`);
  }
  return `${lines.join('\n')}\n`;
}

const payload = await fetchJson(MEMEBOT_URL);
const btc = payload?.btc || payload;
const calls = Array.isArray(btc?.recentCalls) ? btc.recentCalls : [];
const resolved = calls.filter(call => call?.closedAt && ['won', 'lost', 'closed', 'liquidated'].includes(call.status));
if (!resolved.length) throw new Error('No resolved BTC calls were returned by the live Memebot endpoint');
const earliest = Math.min(...resolved.map(call => Number(call.openedAt))) - 120 * minute;
const latest = Math.max(...resolved.map(call => Number(call.closedAt))) + 120 * minute;
const candles = await fetchMinuteCandles(earliest, latest);
if (!candles.length) throw new Error('No Bybit candles were returned for the audit window');
const trades = resolved.map(call => analyzeCall(call, candles));
const report = {
  generatedAt: new Date().toISOString(),
  source: MEMEBOT_URL,
  resolvedCalls: trades.length,
  candleStart: new Date(candles[0].startMs).toISOString(),
  candleEnd: new Date(candles.at(-1).startMs).toISOString(),
  byStrategy: aggregate(trades),
  trades,
};
await fs.mkdir('artifacts', { recursive: true });
await fs.writeFile('artifacts/btc-market-audit.json', JSON.stringify(report, null, 2));
await fs.writeFile('artifacts/btc-market-audit.md', markdown(report));
console.log(markdown(report));
