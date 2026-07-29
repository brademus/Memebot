import { StrategyDefinition } from '../types';
import { cvdDivergence } from './cvd-divergence';
import { ethLedBtcCatchUp } from './eth-led-btc-catch-up';
import { liquidationCascadeExhaustion } from './liquidation-cascade-exhaustion';
import { micropriceOrderBookScalper } from './microprice-orderbook-scalper';
import { postJumpContinuation } from './post-jump-continuation';

export const WAVE2_STRATEGIES: readonly StrategyDefinition[] = Object.freeze([
  liquidationCascadeExhaustion,
  cvdDivergence,
  micropriceOrderBookScalper,
  ethLedBtcCatchUp,
  postJumpContinuation,
]);
