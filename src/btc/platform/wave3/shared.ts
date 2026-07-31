import { BtcDirection, MarketContext } from '../types';

export { candidate, complete, currentPrice, directionalFlow, executionScore, targetFromRisk, recentSwing } from '../wave2/shared';
export type { CandidateInput } from '../wave2/shared';

/**
 * Minimum stop distance as a fraction of entry price.
 *
 * Wave-3 discipline (2026-07-31): the legacy cohort's twenty straight losses
 * traced to structural stops 0.075-0.12% from entry — inside BTC's minute
 * noise, and smaller than round-trip friction on 13 of 20 trades (taker
 * 0.055%/side + slippage ≈ 0.13-0.17% of notional). A stop below friction is
 * unprofitable at ANY win rate. 0.55% keeps modeled friction under ~30% of
 * gross risk (the platform's cost-to-risk cap) with margin to spare.
 */
export const MIN_STOP_DISTANCE_FRACTION = 0.0055;

/**
 * Widen a raw structural stop until it clears the friction floor and an ATR
 * noise floor. Never narrows a stop; direction-aware.
 */
export function frictionFloorStop(
  entry: number,
  rawStop: number,
  direction: BtcDirection,
  atr: number,
  atrFloorMultiple = 0.85,
): number {
  const minDistance = Math.max(
    Math.abs(entry - rawStop),
    entry * MIN_STOP_DISTANCE_FRACTION,
    atr * atrFloorMultiple,
  );
  return direction === 'long' ? entry - minDistance : entry + minDistance;
}

export function utcHour(timestamp: number): number {
  return new Date(timestamp).getUTCHours();
}

export function utcDay(timestamp: number): number {
  return new Date(timestamp).getUTCDay();
}

export function isWeekendUtc(timestamp: number): boolean {
  const day = utcDay(timestamp);
  return day === 6 || day === 0;
}

/**
 * Minutes since the most recent funding settlement, derived from the venue's
 * own nextFundingAt (8h cycle) rather than hardcoded clock times.
 */
export function minutesSinceFundingSettlement(context: MarketContext): number | null {
  const next = context.derivatives.nextFundingAt;
  if (!next || !(next > context.timestamp)) return null;
  const previous = next - 8 * 60 * 60_000;
  const minutes = (context.timestamp - previous) / 60_000;
  return minutes >= 0 && minutes <= 8 * 60 ? minutes : null;
}

/** Distance from price to the nearest $1,000 round level, in fractions of price. */
export function roundLevelContext(price: number): { level: number; distanceFraction: number } {
  const level = Math.round(price / 1_000) * 1_000;
  return { level, distanceFraction: Math.abs(price - level) / price };
}
