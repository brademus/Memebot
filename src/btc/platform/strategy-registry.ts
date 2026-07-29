import { StrategyDefinition } from './types';
import { BTC_STRATEGIES as CORE_BTC_STRATEGIES } from './strategies';
import { WAVE1_STRATEGIES } from './wave1-strategies';

export const BTC_STRATEGIES: readonly StrategyDefinition[] = Object.freeze([
  ...CORE_BTC_STRATEGIES,
  ...WAVE1_STRATEGIES,
]);
