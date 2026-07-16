import { CURVE_SPAN_SOL, CURVE_START_SOL, GRADUATION_SOL } from '../constants';
import { weightedSmartHits } from '../wallets/tracker';
import { MarketRegime, SignalFeatureVector, TokenRecord } from '../types';
import { burstFeatures } from './burst';
import { clamp01, round } from './math';
import { recommendationEligibleSource } from './version';

export function graphEvidenceReady(token: TokenRecord): boolean {
  return token.entityGraph?.complete === true
    || !!(token.bundle && token.bundle.slot0Buyers >= 3 && Number.isFinite(token.bundle.insiderPct));
}

export function flowEvidenceReady(token: TokenRecord, now = Date.now()): boolean {
  const events = token.recentTrades.filter(event => event.at >= now - 5 * 60_000).length;
  return events >= 3 || Math.max(0, Number(token.buys5m) || 0) + Math.max(0, Number(token.sells5m) || 0) >= 6;
}

export function buildSignalFeatures(token: TokenRecord, regime: MarketRegime, now = Date.now()): SignalFeatureVector {
  const burst = burstFeatures(token, now);
  const ageMinutes = Math.max(0, (now - token.firstSeen) / 60_000);
  const bonded = Math.max(0, token.curveSol - CURVE_START_SOL);
  const curveProgress = token.dex === 'pumpfun'
    ? clamp01(bonded / Math.max(1, CURVE_SPAN_SOL))
    : token.gradAt ? 1 : clamp01(token.mcapUsd / 100_000);
  const curveSpeed1m = normalizedCurveSpeed(token, now, 60_000);
  const curveSpeed3m = normalizedCurveSpeed(token, now, 180_000);
  const trades = Math.max(1, token.totalBuys + token.totalSells, token.buys5m + token.sells5m);
  const capitalEfficiency = token.dex === 'pumpfun'
    ? clamp01((bonded / trades) / 0.45)
    : clamp01(Math.log1p(token.vol5m / 2_000) / Math.log(51));
  const liquidityDepth = clamp01(Math.log1p(Math.max(0, token.liquidityUsd)) / Math.log(250_001));
  const buyPressure = clamp01(((token.buys5m + 1) / (token.sells5m + 1) - 0.7) / 2.3);
  const observedBreadth = Math.max(token.uniqueBuyers.length, Number(token.uniqueBuyerSamples[token.uniqueBuyerSamples.length - 1]) || 0);
  const organicBreadth = trades > 0
    ? clamp01(0.55 * Math.log1p(observedBreadth) / Math.log(81)
      + 0.45 * clamp01(observedBreadth / trades / 0.7))
    : 0;
  const smart = weightedSmartHits(token.smartHits, 6 * 3600_000, now);
  const smartMoney = clamp01(smart.weight / 4);
  const socialCredibility = socialScore(token);
  const earlyRetention = token.earlyBuyers.length
    ? clamp01(1 - token.earlyExited.length / token.earlyBuyers.length)
    : 0.5;
  const graph = token.entityGraph;
  const bundleMeasured = !!(token.bundle && token.bundle.slot0Buyers >= 3);
  const bundleIndependence = bundleMeasured
    ? clamp01(1 - token.bundle!.fundedSnipers / Math.max(1, token.bundle!.slot0Buyers))
    : 0.5;
  const bundleRisk = bundleMeasured
    ? clamp01(Number(token.bundle!.clusterPct ?? token.bundle!.insiderPct) / 40)
    : 0.5;
  // Unknown graph evidence is neutral for ranking, not automatically guilty. The
  // production execution gate separately requires graphEvidenceReady().
  const buyerIndependence = graph?.complete ? graph.independenceRatio : bundleIndependence;
  const graphRisk = graph?.complete ? graph.graphRisk : bundleRisk;
  const commonFunderPct = graph?.complete
    ? graph.commonFunderBuyerPct
    : bundleMeasured ? clamp01(token.bundle!.fundedSnipers / Math.max(1, token.bundle!.slot0Buyers)) : 0.5;
  const moved = token.firstScorePrice && token.priceUsd > 0 ? token.priceUsd / token.firstScorePrice - 1 : 0;
  const runupPenalty = clamp01(Math.max(0, moved) / 0.6 + Math.max(0, token.priceChange5m) / 100);
  const deployerClass = token.deployerRep?.cls || 'unlabeled';
  const deployerRisk = deployerClass === 'SERIAL_DEAD' ? 1 : deployerClass === 'SERIAL' ? 0.75 : deployerClass === 'FRESH' ? 0.55 : deployerClass === 'KNOWN' ? 0.25 : 0.5;
  const routePrior = clamp01(
    0.55 * liquidityDepth
    + 0.25 * clamp01((token.liquidityUsd / Math.max(1, token.mcapUsd)) / 0.2)
    + 0.20 * regime.routeHealth,
  );
  const known = [
    token.priceUsd > 0, token.liquidityUsd > 0, token.mcapUsd > 0,
    token.subs?.raw != null, token.socials.fetched, graphEvidenceReady(token),
    flowEvidenceReady(token, now), burst.completeness >= 0.5,
  ].filter(Boolean).length;
  const featureCompleteness = clamp01(known / 8 * 0.85 + regime.completeness * 0.15);

  return {
    ageMinutes: round(ageMinutes, 2), curveProgress: round(curveProgress),
    curveSpeed1m: round(curveSpeed1m), curveSpeed3m: round(curveSpeed3m),
    capitalEfficiency: round(capitalEfficiency), liquidityDepth: round(liquidityDepth),
    buyPressure: round(buyPressure), organicBreadth: round(organicBreadth),
    smartMoney: round(smartMoney), socialCredibility: round(socialCredibility),
    earlyRetention: round(earlyRetention), buyerIndependence: round(buyerIndependence),
    graphRisk: round(graphRisk), commonFunderPct: round(commonFunderPct),
    burstQuality: burst.quality, burstExhaustion: burst.exhaustion,
    walletEntropy: burst.walletEntropy, flowRetention: burst.retainedFlow,
    tradeAcceleration: burst.acceleration, runupPenalty: round(runupPenalty),
    deployerRisk: round(deployerRisk), routePrior: round(routePrior),
    featureCompleteness: round(featureCompleteness),
    sourceEligible: recommendationEligibleSource(token.source) ? 1 : 0,
  };
}

function normalizedCurveSpeed(token: TokenRecord, now: number, windowMs: number): number {
  if (token.curveSamples.length < 2) return 0;
  const recent = token.curveSamples.filter(sample => sample.at >= now - windowMs);
  if (recent.length < 2) return 0;
  const minutes = Math.max(0.05, (recent[recent.length - 1].at - recent[0].at) / 60_000);
  const solPerMinute = (recent[recent.length - 1].sol - recent[0].sol) / minutes;
  return clamp01(0.5 + solPerMinute / Math.max(2, GRADUATION_SOL * 0.04));
}

function socialScore(token: TokenRecord): number {
  if (!token.socials.fetched) return 0.25;
  const telegram = !token.socials.tg ? 0
    : token.socials.tgMembers === null ? 0.4
    : token.socials.tgMembers < 25 ? 0.1
    : token.socials.tgMembers < 200 ? 0.3 : 0.55;
  const staticScore = telegram + (token.socials.x ? 0.25 : 0) + (token.socials.web ? 0.15 : 0);
  const growth = clamp01(Math.max(0, token.tgGrowthPerMin) / 20);
  const paid = clamp01(Math.log1p(Math.max(0, token.boostAmount)) / Math.log(101));
  return clamp01(0.75 * staticScore + 0.15 * growth + 0.10 * paid);
}
