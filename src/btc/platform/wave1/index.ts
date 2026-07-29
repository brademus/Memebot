import { StrategyDefinition } from '../types';
import { adaptiveTrendRider } from './adaptive-trend-rider';
import { donchianTrendBreakout } from './donchian-trend-breakout';
import { fundingCrowdingReversal } from './funding-crowding-reversal';
import { perpetualPremiumConvergence } from './perpetual-premium-convergence';
import { priceOpenInterestState } from './price-oi-state';
export { resetWave1StrategyStateForTests } from './shared';

export const WAVE1_STRATEGIES: readonly StrategyDefinition[] = Object.freeze([
  adaptiveTrendRider,
  donchianTrendBreakout,
  fundingCrowdingReversal,
  perpetualPremiumConvergence,
  priceOpenInterestState,
]);
