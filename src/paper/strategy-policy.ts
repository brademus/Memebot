export const STRATEGY_VERSION = 'quality-entry-exit-v1';
export const STRATEGY_NOTIONAL_USD = 100;

export type StrategyRole = 'quality_observation' | 'timed_entry' | 'model_observation' | 'legacy';
export type StrategyDecisionAction = 'hold' | 'sell';

export interface StrategyExitInput {
  role: StrategyRole;
  entryPrice: number;
  markPrice: number;
  peakPrice: number;
  ageHours: number;
  entryScore: number | null;
  currentScore: number | null;
  entryLiquidityUsd: number | null;
  currentLiquidityUsd: number | null;
  buys5m: number;
  sells5m: number;
  priceChange5m: number | null;
  entrySmartWallets: number;
  currentSmartWallets: number;
  earlyRetention: number | null;
  modelExpectedValue: number | null;
  modelDownsideProbability: number | null;
  state: string | null;
  insiderKilled: boolean;
  fundedSnipers: number;
}

export interface StrategyExitEvaluation {
  action: StrategyDecisionAction;
  reasonCode: string;
  reasons: string[];
  exitPrice: number | null;
  multiple: number;
  peakMultiple: number;
  activeStopMultiple: number;
  deteriorationSignals: string[];
  metrics: Record<string, number | string | boolean | null>;
}

export const ADAPTIVE_EXIT_POLICY = {
  takeProfitMultiple: 3,
  hardStopMultiple: 0.5,
  maxHoldHours: 24,
  firstProfitArmMultiple: 1.5,
  firstProfitTrailPct: 0.30,
  firstProfitFloorMultiple: 1.05,
  secondProfitArmMultiple: 2,
  secondProfitTrailPct: 0.25,
  secondProfitFloorMultiple: 1.35,
  scoreDropPoints: 15,
  sellPressureRatio: 0.75,
  liquidityWarningDropPct: 0.25,
  liquidityEmergencyDropPct: 0.50,
  earlyRetentionFloor: 0.50,
  modelNegativeExpectedValue: 0,
  modelHighDownsideProbability: 0.55,
  deteriorationSignalsToExit: 3,
} as const;

const finite = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const clampPositive = (value: number): number => Number.isFinite(value) && value > 0 ? value : 0;

export function strategyRoleForSignal(signal: string): StrategyRole {
  if (signal === 'trigger') return 'timed_entry';
  if (signal.startsWith('bb_') || signal === 'conviction') return 'quality_observation';
  if (signal.startsWith('model')) return 'model_observation';
  return 'legacy';
}

export function benchmarkExitDecision(entryPrice: number, markPrice: number, peakPrice: number, ageHours: number): StrategyExitEvaluation {
  const entry = clampPositive(entryPrice);
  const mark = clampPositive(markPrice);
  const peak = Math.max(mark, clampPositive(peakPrice));
  const multiple = entry > 0 && mark > 0 ? mark / entry : 0;
  const peakMultiple = entry > 0 && peak > 0 ? peak / entry : multiple;
  const metrics = { entryPrice: entry, markPrice: mark, peakPrice: peak, ageHours, multiple, peakMultiple };

  if (peakMultiple >= ADAPTIVE_EXIT_POLICY.takeProfitMultiple) {
    return {
      action: 'sell', reasonCode: 'benchmark_take_profit_3x',
      reasons: ['The research observation reached the fixed 3x benchmark.'],
      exitPrice: entry * ADAPTIVE_EXIT_POLICY.takeProfitMultiple,
      multiple: ADAPTIVE_EXIT_POLICY.takeProfitMultiple, peakMultiple,
      activeStopMultiple: ADAPTIVE_EXIT_POLICY.hardStopMultiple,
      deteriorationSignals: [], metrics,
    };
  }
  if (multiple <= ADAPTIVE_EXIT_POLICY.hardStopMultiple) {
    return {
      action: 'sell', reasonCode: 'benchmark_stop_loss_50pct',
      reasons: ['The research observation reached the fixed 50% loss benchmark.'],
      exitPrice: entry * ADAPTIVE_EXIT_POLICY.hardStopMultiple,
      multiple: ADAPTIVE_EXIT_POLICY.hardStopMultiple, peakMultiple,
      activeStopMultiple: ADAPTIVE_EXIT_POLICY.hardStopMultiple,
      deteriorationSignals: [], metrics,
    };
  }
  if (ageHours >= ADAPTIVE_EXIT_POLICY.maxHoldHours) {
    return {
      action: 'sell', reasonCode: 'benchmark_time_24h',
      reasons: ['The fixed research observation reached its 24-hour measurement horizon.'],
      exitPrice: mark, multiple, peakMultiple,
      activeStopMultiple: ADAPTIVE_EXIT_POLICY.hardStopMultiple,
      deteriorationSignals: [], metrics,
    };
  }
  return {
    action: 'hold', reasonCode: 'benchmark_collecting',
    reasons: ['The quality observation is still collecting fixed-policy outcome evidence; it is not counted as a purchased position.'],
    exitPrice: null, multiple, peakMultiple,
    activeStopMultiple: ADAPTIVE_EXIT_POLICY.hardStopMultiple,
    deteriorationSignals: [], metrics,
  };
}

export function adaptiveExitDecision(input: StrategyExitInput): StrategyExitEvaluation {
  const entry = clampPositive(input.entryPrice);
  const mark = clampPositive(input.markPrice);
  const peak = Math.max(mark, clampPositive(input.peakPrice));
  const multiple = entry > 0 && mark > 0 ? mark / entry : 0;
  const peakMultiple = entry > 0 && peak > 0 ? peak / entry : multiple;
  const buySellRatio = input.sells5m > 0 ? input.buys5m / input.sells5m : input.buys5m > 0 ? 3 : 1;
  const scoreDrop = input.entryScore !== null && input.currentScore !== null
    ? input.entryScore - input.currentScore : 0;
  const liquidityDropPct = input.entryLiquidityUsd && input.entryLiquidityUsd > 0 && input.currentLiquidityUsd !== null
    ? Math.max(0, 1 - input.currentLiquidityUsd / input.entryLiquidityUsd) : 0;

  let activeStopMultiple = ADAPTIVE_EXIT_POLICY.hardStopMultiple;
  if (peakMultiple >= ADAPTIVE_EXIT_POLICY.secondProfitArmMultiple) {
    activeStopMultiple = Math.max(
      ADAPTIVE_EXIT_POLICY.secondProfitFloorMultiple,
      peakMultiple * (1 - ADAPTIVE_EXIT_POLICY.secondProfitTrailPct),
    );
  } else if (peakMultiple >= ADAPTIVE_EXIT_POLICY.firstProfitArmMultiple) {
    activeStopMultiple = Math.max(
      ADAPTIVE_EXIT_POLICY.firstProfitFloorMultiple,
      peakMultiple * (1 - ADAPTIVE_EXIT_POLICY.firstProfitTrailPct),
    );
  }

  const deteriorationSignals: string[] = [];
  if (buySellRatio < ADAPTIVE_EXIT_POLICY.sellPressureRatio && input.buys5m + input.sells5m >= 8)
    deteriorationSignals.push(`sell pressure dominates: buy/sell ${buySellRatio.toFixed(2)}`);
  if (scoreDrop >= ADAPTIVE_EXIT_POLICY.scoreDropPoints)
    deteriorationSignals.push(`score deteriorated ${scoreDrop.toFixed(1)} points from entry`);
  if (liquidityDropPct >= ADAPTIVE_EXIT_POLICY.liquidityWarningDropPct)
    deteriorationSignals.push(`liquidity fell ${(liquidityDropPct * 100).toFixed(1)}% from entry`);
  if (input.entrySmartWallets > 0 && input.currentSmartWallets === 0)
    deteriorationSignals.push('entry smart-wallet confirmation is no longer present');
  if (input.earlyRetention !== null && input.earlyRetention < ADAPTIVE_EXIT_POLICY.earlyRetentionFloor)
    deteriorationSignals.push(`early-buyer retention weakened to ${(input.earlyRetention * 100).toFixed(1)}%`);
  if (input.modelExpectedValue !== null && input.modelExpectedValue < ADAPTIVE_EXIT_POLICY.modelNegativeExpectedValue)
    deteriorationSignals.push(`model expected value turned negative (${input.modelExpectedValue.toFixed(3)})`);
  if (input.modelDownsideProbability !== null
      && input.modelDownsideProbability > ADAPTIVE_EXIT_POLICY.modelHighDownsideProbability)
    deteriorationSignals.push(`model downside probability rose to ${(input.modelDownsideProbability * 100).toFixed(1)}%`);
  if (input.state === 'DYING' || input.state === 'DEAD')
    deteriorationSignals.push(`token state changed to ${input.state}`);
  if (input.priceChange5m !== null && input.priceChange5m <= -25)
    deteriorationSignals.push(`five-minute price change collapsed to ${input.priceChange5m.toFixed(1)}%`);

  const metrics: Record<string, number | string | boolean | null> = {
    entryPrice: entry,
    markPrice: mark,
    peakPrice: peak,
    multiple,
    peakMultiple,
    activeStopMultiple,
    ageHours: input.ageHours,
    entryScore: finite(input.entryScore),
    currentScore: finite(input.currentScore),
    scoreDrop,
    entryLiquidityUsd: finite(input.entryLiquidityUsd),
    currentLiquidityUsd: finite(input.currentLiquidityUsd),
    liquidityDropPct,
    buys5m: input.buys5m,
    sells5m: input.sells5m,
    buySellRatio,
    entrySmartWallets: input.entrySmartWallets,
    currentSmartWallets: input.currentSmartWallets,
    earlyRetention: finite(input.earlyRetention),
    modelExpectedValue: finite(input.modelExpectedValue),
    modelDownsideProbability: finite(input.modelDownsideProbability),
    state: input.state,
    insiderKilled: input.insiderKilled,
    fundedSnipers: input.fundedSnipers,
  };

  if (peakMultiple >= ADAPTIVE_EXIT_POLICY.takeProfitMultiple) {
    return {
      action: 'sell', reasonCode: 'strategy_take_profit_3x',
      reasons: ['The timed paper entry reached the 3x profit objective.'],
      exitPrice: entry * ADAPTIVE_EXIT_POLICY.takeProfitMultiple,
      multiple: ADAPTIVE_EXIT_POLICY.takeProfitMultiple, peakMultiple, activeStopMultiple,
      deteriorationSignals, metrics,
    };
  }
  if (multiple <= ADAPTIVE_EXIT_POLICY.hardStopMultiple) {
    return {
      action: 'sell', reasonCode: 'strategy_hard_stop_50pct',
      reasons: ['The timed paper entry reached the maximum 50% loss.'],
      exitPrice: entry * ADAPTIVE_EXIT_POLICY.hardStopMultiple,
      multiple: ADAPTIVE_EXIT_POLICY.hardStopMultiple, peakMultiple, activeStopMultiple,
      deteriorationSignals, metrics,
    };
  }
  if (input.insiderKilled || input.fundedSnipers > 0) {
    return {
      action: 'sell', reasonCode: 'strategy_insider_risk_exit',
      reasons: [input.insiderKilled ? 'Late evidence marked the token as insider-controlled.' : 'Deployer-linked funded snipers appeared after entry.'],
      exitPrice: mark, multiple, peakMultiple, activeStopMultiple,
      deteriorationSignals, metrics,
    };
  }
  if (liquidityDropPct >= ADAPTIVE_EXIT_POLICY.liquidityEmergencyDropPct) {
    return {
      action: 'sell', reasonCode: 'strategy_liquidity_emergency_exit',
      reasons: [`Liquidity fell ${(liquidityDropPct * 100).toFixed(1)}% from the entry snapshot.`],
      exitPrice: mark, multiple, peakMultiple, activeStopMultiple,
      deteriorationSignals, metrics,
    };
  }
  if (peakMultiple >= ADAPTIVE_EXIT_POLICY.firstProfitArmMultiple && multiple <= activeStopMultiple) {
    return {
      action: 'sell', reasonCode: peakMultiple >= ADAPTIVE_EXIT_POLICY.secondProfitArmMultiple
        ? 'strategy_trailing_profit_exit_2x' : 'strategy_profit_lock_exit_1_5x',
      reasons: [`Profit protection armed at ${peakMultiple.toFixed(2)}x and price retraced to ${multiple.toFixed(2)}x, below the ${activeStopMultiple.toFixed(2)}x active floor.`],
      exitPrice: mark, multiple, peakMultiple, activeStopMultiple,
      deteriorationSignals, metrics,
    };
  }

  const deteriorationExit = deteriorationSignals.length >= ADAPTIVE_EXIT_POLICY.deteriorationSignalsToExit
    || (deteriorationSignals.length >= 2 && (multiple >= 1.05 || multiple <= 0.85));
  if (deteriorationExit) {
    return {
      action: 'sell', reasonCode: 'strategy_multi_signal_deterioration_exit',
      reasons: [`${deteriorationSignals.length} independent post-entry conditions deteriorated.`, ...deteriorationSignals],
      exitPrice: mark, multiple, peakMultiple, activeStopMultiple,
      deteriorationSignals, metrics,
    };
  }
  if (input.ageHours >= ADAPTIVE_EXIT_POLICY.maxHoldHours) {
    return {
      action: 'sell', reasonCode: 'strategy_time_exit_24h',
      reasons: ['The timed entry reached the 24-hour maximum holding period without reaching the profit objective.'],
      exitPrice: mark, multiple, peakMultiple, activeStopMultiple,
      deteriorationSignals, metrics,
    };
  }

  const holdReasons = [
    `Position remains above its active ${activeStopMultiple.toFixed(2)}x protection floor.`,
    deteriorationSignals.length
      ? `${deteriorationSignals.length} deterioration signal(s) are present, below the current exit threshold.`
      : 'No material post-entry deterioration is confirmed.',
  ];
  return {
    action: 'hold', reasonCode: 'strategy_hold', reasons: holdReasons,
    exitPrice: null, multiple, peakMultiple, activeStopMultiple,
    deteriorationSignals, metrics,
  };
}
