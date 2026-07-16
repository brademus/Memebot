import { BurstFeatures, TokenRecord, TradeEvent } from '../types';
import { clamp01, mean, normalizedEntropy, round, standardDeviation } from './math';

const WINDOW_MS = 5 * 60_000;
const BURST_MS = 15_000;
function amount(event: TradeEvent): number {
  const value = Math.abs(Number(event.solAmount || 0));
  return Number.isFinite(value) ? value : 0;
}
function maxWindowShare(events: TradeEvent[], windowMs: number): number {
  if (!events.length) return 0;
  let start = 0, maximum = 1;
  for (let end = 0; end < events.length; end++) {
    while (events[end].at - events[start].at > windowMs) start++;
    maximum = Math.max(maximum, end - start + 1);
  }
  return maximum / events.length;
}

export function burstFeatures(token: TokenRecord, now = Date.now()): BurstFeatures {
  const events = (token.recentTrades || []).filter(event => event.at >= now - WINDOW_MS).sort((a, b) => a.at - b.at);
  if (events.length >= 3) return eventBurstFeatures(events, now);
  return aggregateBurstFeatures(token);
}

function eventBurstFeatures(events: TradeEvent[], now: number): BurstFeatures {
  const count = events.length;
  const buys = events.filter(event => event.buy);
  const sells = count - buys.length;
  const wallets = events.map(event => event.wallet || '').filter(Boolean);
  const uniqueWallets = new Set(wallets).size;
  const interarrivals: number[] = [];
  for (let index = 1; index < events.length; index++) interarrivals.push(Math.max(0, (events[index].at - events[index - 1].at) / 1000));
  const interarrivalMean = mean(interarrivals);
  const interarrivalSd = standardDeviation(interarrivals);
  const interarrivalCv = interarrivalMean > 0 ? interarrivalSd / interarrivalMean : 0;
  const burstiness = interarrivalMean + interarrivalSd > 0 ? (interarrivalSd - interarrivalMean) / (interarrivalSd + interarrivalMean) : 0;
  const max15sShare = maxWindowShare(events, BURST_MS);
  const buyShare = count ? buys.length / count : 0;
  // Entropy among two repeating bots can be mathematically maximal despite almost no
  // economic breadth. Scale Shannon entropy by distinct-wallet support.
  const walletEntropy = wallets.length
    ? normalizedEntropy(wallets) * clamp01(uniqueWallets / Math.max(3, Math.min(12, count)))
    : 0;
  const walletCoverage = count ? wallets.length / count : 0;
  const uniqueTradeRatio = buys.length ? uniqueWallets / buys.length : 0;
  const grossSol = events.reduce((sum, event) => sum + amount(event), 0);
  const netSol = events.reduce((sum, event) => sum + (event.buy ? amount(event) : -amount(event)), 0);
  const retainedFlow = grossSol > 0 ? clamp01((netSol / grossSol + 1) / 2) : clamp01(buyShare);
  const last30 = events.filter(event => event.at >= now - 30_000);
  const prior60 = events.filter(event => event.at >= now - 90_000 && event.at < now - 30_000);
  const rateRecent = last30.length / 30, ratePrior = prior60.length / 60;
  const acceleration = clamp01(0.5 + (rateRecent - ratePrior) / Math.max(0.15, rateRecent + ratePrior));
  const rapidIntervals = interarrivals.filter(seconds => seconds <= 2).length;
  const branchingProxy = interarrivals.length ? clamp01((rapidIntervals / interarrivals.length) * (1 - 0.5 * clamp01(uniqueTradeRatio))) : 0;
  const exhaustion = clamp01(
    0.27 * (count ? sells / count : 0) + 0.22 * max15sShare + 0.20 * (1 - acceleration)
    + 0.13 * (1 - walletEntropy) + 0.10 * branchingProxy + 0.08 * (1 - retainedFlow),
  );
  const quality = clamp01(
    0.24 * buyShare + 0.22 * retainedFlow + 0.18 * walletEntropy + 0.16 * acceleration
    + 0.12 * clamp01(uniqueTradeRatio) + 0.08 * (1 - max15sShare),
  );
  const completeness = clamp01(0.45 * Math.min(1, count / 20) + 0.30 * walletCoverage + 0.25 * Math.min(1, grossSol / 2));
  return {
    tradeCount: count, buyShare: round(buyShare), uniqueWallets, uniqueTradeRatio: round(uniqueTradeRatio),
    walletEntropy: round(walletEntropy), interarrivalMeanSeconds: round(interarrivalMean, 2),
    interarrivalCv: round(interarrivalCv), burstiness: round(burstiness), max15sShare: round(max15sShare),
    branchingProxy: round(branchingProxy), grossSol: round(grossSol), netSol: round(netSol),
    retainedFlow: round(retainedFlow), acceleration: round(acceleration), exhaustion: round(exhaustion),
    quality: round(quality), completeness: round(completeness),
  };
}

// Aggregate fallback for installations without the metered PumpPortal trade stream.
// It deliberately does not invent wallets, slots, signatures, or exact interarrival
// times. Those fields remain low-confidence while buy/sell pressure, volume, breadth
// trend, retention, and acceleration can still participate in shadow research.
function aggregateBurstFeatures(token: TokenRecord): BurstFeatures {
  const buys = Math.max(0, Number(token.buys5m) || 0);
  const sells = Math.max(0, Number(token.sells5m) || 0);
  const count = buys + sells;
  const buyShare = count ? buys / count : 0;
  const samples = (token.uniqueBuyerSamples || []).map(Number).filter(Number.isFinite);
  const latestBreadth = Math.max(0, Number((token.uniqueBuyers || []).length) || Number(samples[samples.length - 1]) || 0);
  const priorBreadth = Math.max(0, Number(samples[0]) || 0);
  const uniqueWallets = Math.min(Math.round(latestBreadth), Math.round(buys));
  const uniqueTradeRatio = buys ? clamp01(latestBreadth / buys) : 0;
  const walletEntropy = clamp01(0.55 * uniqueTradeRatio + 0.45 * Math.min(1, latestBreadth / 20));
  const acceleration = samples.length > 1
    ? clamp01(0.5 + (latestBreadth - priorBreadth) / Math.max(1, latestBreadth + priorBreadth))
    : clamp01(0.5 + (Number(token.priceChange5m) || 0) / 100);
  const retainedFlow = clamp01(buyShare);
  const volumeUsd = Math.max(0, Number(token.vol5m) || 0);
  const volumeDepth = clamp01(Math.log1p(volumeUsd) / Math.log(100_001));
  const max15sShare = count ? clamp01(0.55 - 0.35 * Math.min(1, count / 40)) : 0;
  const branchingProxy = count ? clamp01((1 - uniqueTradeRatio) * Math.min(1, count / 30)) : 0;
  const exhaustion = clamp01(
    0.31 * (count ? sells / count : 0) + 0.19 * max15sShare + 0.21 * (1 - acceleration)
    + 0.15 * (1 - walletEntropy) + 0.08 * branchingProxy + 0.06 * (1 - retainedFlow),
  );
  const quality = clamp01(
    0.30 * buyShare + 0.23 * retainedFlow + 0.16 * walletEntropy + 0.17 * acceleration
    + 0.08 * uniqueTradeRatio + 0.06 * volumeDepth,
  );
  const completeness = count
    ? clamp01(0.38 * Math.min(1, count / 20) + 0.24 * volumeDepth + 0.20 * Math.min(1, samples.length / 4) + 0.18)
    : 0;
  return {
    tradeCount: count, buyShare: round(buyShare), uniqueWallets, uniqueTradeRatio: round(uniqueTradeRatio),
    walletEntropy: round(walletEntropy), interarrivalMeanSeconds: 0, interarrivalCv: 0,
    burstiness: 0, max15sShare: round(max15sShare), branchingProxy: round(branchingProxy),
    grossSol: 0, netSol: 0, retainedFlow: round(retainedFlow), acceleration: round(acceleration),
    exhaustion: round(exhaustion), quality: round(quality), completeness: round(completeness),
  };
}
