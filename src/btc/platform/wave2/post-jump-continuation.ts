import { averageTrueRange, median, safeDiv } from '../indicators';
import { BtcDirection, Candle, StrategyCandidate, StrategyDefinition } from '../types';
import { candidate, complete, directionalFlow, executionScore, targetFromRisk } from './shared';

interface JumpSignal {
  impulse: Candle;
  after: Candle[];
  direction: BtcDirection;
  volumeRatio: number;
  rangeRatio: number;
  closeLocation: number;
}

function findJump(candles: Candle[], atr: number): JumpSignal | null {
  for (const offset of [4, 3, 2]) {
    const index = candles.length - offset;
    if (index < 24) continue;
    const impulse = candles[index];
    const baseline = candles.slice(index - 24, index);
    const after = candles.slice(index + 1);
    if (!after.length) continue;
    const range = impulse.high - impulse.low;
    const volumeRatio = safeDiv(impulse.volume, median(baseline.map(candle => candle.volume)), 0);
    const rangeRatio = safeDiv(range, atr, 0);
    const closeLocation = safeDiv(impulse.close - impulse.low, range, 0.5);
    const direction: BtcDirection | null = impulse.close > impulse.open && closeLocation >= 0.78 ? 'long'
      : impulse.close < impulse.open && closeLocation <= 0.22 ? 'short' : null;
    if (!direction || volumeRatio < 1.8 || rangeRatio < 1.7) continue;
    return { impulse, after, direction, volumeRatio, rangeRatio, closeLocation };
  }
  return null;
}

export const postJumpContinuation: StrategyDefinition = {
  id: 'btc-post-jump-continuation',
  version: '0.1.0-shadow',
  name: 'Post-Jump Continuation',
  description: 'Researches continuation after a high-volume discontinuous move forms a controlled shelf instead of immediately mean reverting.',
  mode: 'shadow',
  leverageCap: 25,
  evaluate(context): StrategyCandidate[] {
    if (!context.feed.healthy || context.regime.liquidity === 'dislocated') return [];
    const candles = complete(context.candles.fiveMinute);
    if (candles.length < 45) return [];
    const atr = averageTrueRange(candles, 20);
    if (!(atr > 0)) return [];
    const jump = findJump(candles, atr);
    if (!jump) return [];
    const { impulse, after, direction, volumeRatio, rangeRatio, closeLocation } = jump;
    const range = impulse.high - impulse.low;
    const latest = after.at(-1)!;
    const shelfFloor = impulse.low + range * 0.42;
    const shelfCeiling = impulse.high - range * 0.42;
    const shelfHeld = direction === 'long'
      ? after.every(candle => candle.low >= shelfFloor) && latest.close >= impulse.low + range * 0.68
      : after.every(candle => candle.high <= shelfCeiling) && latest.close <= impulse.high - range * 0.68;
    if (!shelfHeld) return [];
    const continuation = direction === 'long'
      ? latest.close > after[0].close && latest.close >= latest.open
      : latest.close < after[0].close && latest.close <= latest.open;
    if (!continuation) return [];
    const flow = directionalFlow(context, direction);
    if (flow < 1.06) return [];

    const entry = direction === 'long' ? impulse.low + range * 0.64 : impulse.high - range * 0.64;
    const stop = direction === 'long' ? impulse.low - atr * 0.12 : impulse.high + atr * 0.12;
    const initialTarget = targetFromRisk(entry, stop, direction, 3.5);
    const extendedTarget = targetFromRisk(entry, stop, direction, 5.5);

    return [candidate(context, {
      strategyId: this.id,
      strategyVersion: this.version,
      strategyName: this.name,
      mode: this.mode,
      direction,
      setupType: direction === 'long' ? 'bull_jump_shelf_continuation' : 'bear_jump_shelf_continuation',
      entryMethod: 'retest',
      preferredEntry: entry,
      entryZoneLow: direction === 'long' ? impulse.low + range * 0.52 : impulse.high - range * 0.74,
      entryZoneHigh: direction === 'long' ? impulse.low + range * 0.74 : impulse.high - range * 0.52,
      doNotChasePrice: direction === 'long' ? impulse.high + atr * 0.45 : impulse.low - atr * 0.45,
      expiresAt: context.timestamp + 35 * 60_000,
      structuralStop: stop,
      initialTarget,
      extendedTarget,
      maximumRealisticTarget: direction === 'long'
        ? entry + Math.max(range * 3.2, entry * 0.04)
        : entry - Math.max(range * 3.2, entry * 0.04),
      strategyLeverageCap: this.leverageCap,
      expectedHoldingMinutes: 150,
      exitModel: 'partial_runner',
      signalScore: 68 + Math.min(14, (volumeRatio - 1.8) * 12) + Math.min(14, (rangeRatio - 1.7) * 10) + Math.max(0, flow - 1) * 12,
      regimeScore: context.regime.direction === 'range' ? 70 : 86,
      executionScore: executionScore(context, 30),
      rationale: [
        `${direction} jump candle volume ${volumeRatio.toFixed(2)}x baseline`,
        `jump range ${rangeRatio.toFixed(2)}x five-minute ATR`,
        `${after.length}-bar post-jump shelf retained the impulse`,
        `continuation flow ratio ${flow.toFixed(2)}`,
      ],
      features: {
        impulseAt: impulse.startMs,
        volumeRatio,
        rangeRatio,
        closeLocation,
        shelfBars: after.length,
        shelfFloor,
        shelfCeiling,
        flowRatio: flow,
        impulseRange: range,
        atr,
      },
    })];
  },
};
