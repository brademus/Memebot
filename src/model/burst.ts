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
  let start = 0;
  let maximum = 1;
  for (let end = 0; end < events.length; end++) {
    while (events[end].at - events[start].at > windowMs) start++;
    maximum = Math.max(maximum, end - start + 1);
  }
  return maximum / events.length;
}

export function burstFeatures(token: TokenRecord, now = Date.now()): BurstFeatures {
  const events = token.recentTrades
    .filter(event => event.at >= now - WINDOW_MS)
    .sort((left, right) => left.at - right.at);
  const count = events.length;
  const buys = events.filter(event => event.buy);
  const sells = count - buys.length;
  const wallets = events.map(event => event.wallet || '').filter(Boolean);
  const uniqueWallets = new Set(wallets).size;
  const interarrivals: number[] = [];
  for (let index = 1; index < events.length; index++) {
    interarrivals.push(Math.max(0, (events[index].at - events[index - 1].at) / 1000));
  }
  const interarrivalMean = mean(interarrivals);
  const interarrivalSd = standardDeviation(interarrivals);
  const interarrivalCv = interarrivalMean > 0 ? interarrivalSd / interarrivalMean : 0;
  const burstiness = interarrivalMean + interarrivalSd > 0
    ? (interarrivalSd - interarrivalMean) / (interarrivalSd + interarrivalMean)
    : 0;
  const max15sShare = maxWindowShare(events, BURST_MS);
  const buyShare = count ? buys.length / count : 0;
  const walletEntropy = wallets.length ? normalizedEntropy(wallets) : 0;
  const walletCoverage = count ? wallets.length / count : 0;
  const uniqueTradeRatio = buys.length ? uniqueWallets / buys.length : 0;

  const grossSol = events.reduce((sum, event) => sum + amount(event), 0);
  const netSol = events.reduce((sum, event) => sum + (event.buy ? amount(event) : -amount(event)), 0);
  const retainedFlow = grossSol > 0 ? clamp01((netSol / grossSol + 1) / 2) : clamp01(buyShare);

  const last30 = events.filter(event => event.at >= now - 30_000);
  const prior60 = events.filter(event => event.at >= now - 90_000 && event.at < now - 30_000);
  const rateRecent = last30.length / 30;
  const ratePrior = prior60.length / 60;
  const acceleration = clamp01(0.5 + (rateRecent - ratePrior) / Math.max(0.15, rateRecent + ratePrior));
  const rapidIntervals = interarrivals.filter(seconds => seconds <= 2).length;
  const branchingProxy = interarrivals.length
    ? clamp01((rapidIntervals / interarrivals.length) * (1 - 0.5 * clamp01(uniqueTradeRatio)))
    : 0;
  const sellPressure = count ? sells / count : 0;
  const negativeAcceleration = 1 - acceleration;

  const exhaustion = clamp01(
    0.27 * sellPressure
    + 0.22 * max15sShare
    + 0.20 * negativeAcceleration
    + 0.13 * (1 - walletEntropy)
    + 0.10 * branchingProxy
    + 0.08 * (1 - retainedFlow),
  );
  const quality = clamp01(
    0.24 * buyShare
    + 0.22 * retainedFlow
    + 0.18 * walletEntropy
    + 0.16 * acceleration
    + 0.12 * clamp01(uniqueTradeRatio)
    + 0.08 * (1 - max15sShare),
  );
  const completeness = clamp01(
    0.45 * Math.min(1, count / 20)
    + 0.30 * walletCoverage
    + 0.25 * Math.min(1, grossSol / 2),
  );

  return {
    tradeCount: count,
    buyShare: round(buyShare),
    uniqueWallets,
    uniqueTradeRatio: round(uniqueTradeRatio),
    walletEntropy: round(walletEntropy),
    interarrivalMeanSeconds: round(interarrivalMean, 2),
    interarrivalCv: round(interarrivalCv),
    burstiness: round(burstiness),
    max15sShare: round(max15sShare),
    branchingProxy: round(branchingProxy),
    grossSol: round(grossSol),
    netSol: round(netSol),
    retainedFlow: round(retainedFlow),
    acceleration: round(acceleration),
    exhaustion: round(exhaustion),
    quality: round(quality),
    completeness: round(completeness),
  };
}
