import { StrategyDefinition } from '../types';
import { ethLedLagShort } from './eth-led-lag-short';
import { failedBreakoutSnapback } from './failed-breakout-snapback';
import { fundingSettlementRelief } from './funding-settlement-relief';
import { mondayAsiaTrend } from './monday-asia-trend';
import { oiPurgeRebound } from './oi-purge-rebound';
import { roundLevelRejection } from './round-level-rejection';
import { spotLedDrive } from './spot-led-drive';
import { usOpenRangeExpansion } from './us-open-range-expansion';
import { vwapDisconnectReversion } from './vwap-disconnect-reversion';
import { weekendRangeFade } from './weekend-range-fade';

export const WAVE3_STRATEGIES: readonly StrategyDefinition[] = Object.freeze([
  usOpenRangeExpansion,
  mondayAsiaTrend,
  fundingSettlementRelief,
  oiPurgeRebound,
  vwapDisconnectReversion,
  spotLedDrive,
  roundLevelRejection,
  ethLedLagShort,
  weekendRangeFade,
  failedBreakoutSnapback,
]);
