import { averageTrueRange } from '../indicators';
import { BtcDirection, StrategyCandidate, StrategyDefinition } from '../types';
import { candidate, complete, currentPrice, directionalFlow, executionScore, targetFromRisk } from './shared';

export const ethLedBtcCatchUp: StrategyDefinition = {
  id: 'btc-eth-led-catch-up',
  version: '0.1.0-shadow',
  name: 'ETH-Led BTC Catch-Up',
  description: 'Researches short-horizon BTC catch-up after a fresh ETH move leads BTC and BTC order flow begins confirming the same direction.',
  mode: 'shadow',
  leverageCap: 20,
  evaluate(context): StrategyCandidate[] {
    const cross = context.crossAsset;
    if (!context.feed.healthy || !cross?.healthy || context.regime.liquidity === 'dislocated') return [];
    const eth5 = cross.ethReturn5mPct;
    const btc5 = cross.btcReturn5mPct;
    const relative5 = cross.relativeReturn5mPct;
    const relative15 = cross.relativeReturn15mPct;
    if (eth5 === null || btc5 === null || relative5 === null || relative15 === null) return [];

    let direction: BtcDirection | null = null;
    if (eth5 >= 0.35 && relative5 >= 0.25 && relative15 >= 0.12 && btc5 < eth5) direction = 'long';
    if (eth5 <= -0.35 && relative5 <= -0.25 && relative15 <= -0.12 && btc5 > eth5) direction = 'short';
    if (!direction) return [];
    const flow = directionalFlow(context, direction, 'one');
    if (flow < 1.05) return [];

    const oneMinute = complete(context.candles.oneMinute);
    if (oneMinute.length < 22) return [];
    const latest = oneMinute.at(-1)!;
    const atr = averageTrueRange(oneMinute, 20);
    if (!(atr > 0)) return [];
    const confirmation = direction === 'long' ? latest.close >= latest.open : latest.close <= latest.open;
    if (!confirmation) return [];

    const entry = currentPrice(context, direction);
    const stop = direction === 'long' ? latest.low - atr * 0.2 : latest.high + atr * 0.2;
    const initialTarget = targetFromRisk(entry, stop, direction, 3.35);
    const extendedTarget = targetFromRisk(entry, stop, direction, 5);

    return [candidate(context, {
      strategyId: this.id,
      strategyVersion: this.version,
      strategyName: this.name,
      mode: this.mode,
      direction,
      setupType: direction === 'long' ? 'eth_up_btc_lag' : 'eth_down_btc_lag',
      entryMethod: 'market',
      preferredEntry: entry,
      entryZoneLow: direction === 'long' ? entry - atr * 0.12 : entry - atr * 0.05,
      entryZoneHigh: direction === 'long' ? entry + atr * 0.05 : entry + atr * 0.12,
      doNotChasePrice: direction === 'long' ? entry + atr * 0.5 : entry - atr * 0.5,
      expiresAt: context.timestamp + 8 * 60_000,
      structuralStop: stop,
      initialTarget,
      extendedTarget,
      maximumRealisticTarget: direction === 'long'
        ? entry + Math.max(atr * 20, entry * 0.028)
        : entry - Math.max(atr * 20, entry * 0.028),
      strategyLeverageCap: this.leverageCap,
      expectedHoldingMinutes: 45,
      exitModel: 'partial_runner',
      signalScore: 70 + Math.min(16, Math.abs(relative5) * 28) + Math.min(8, Math.abs(relative15) * 18) + Math.max(0, flow - 1) * 12,
      regimeScore: context.regime.volatility === 'extreme' ? 62 : 84,
      executionScore: executionScore(context, 30),
      dataScore: cross.healthy ? 100 : 0,
      rationale: [
        `ETH five-minute return ${eth5.toFixed(2)}% versus BTC ${btc5.toFixed(2)}%`,
        `ETH relative lead ${relative5.toFixed(2)}% over five minutes and ${relative15.toFixed(2)}% over fifteen minutes`,
        `BTC one-minute flow confirms ${direction} at ${flow.toFixed(2)}x`,
        'shadow-only until cross-asset lead persistence and alert latency are measured prospectively',
      ],
      features: {
        ethSpot: cross.ethSpot,
        ethAgeMs: cross.ethAgeMs,
        ethReturn5mPct: eth5,
        btcReturn5mPct: btc5,
        relativeReturn5mPct: relative5,
        ethReturn15mPct: cross.ethReturn15mPct,
        btcReturn15mPct: cross.btcReturn15mPct,
        relativeReturn15mPct: relative15,
        flowRatio: flow,
        atr,
      },
    })];
  },
};
