from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one replacement, found {count}")
    return text.replace(old, new, 1)


risk_path = Path('src/btc/platform/risk.ts')
risk = risk_path.read_text()
risk = replace_once(
    risk,
    """function priceMovePct(entry: number, exit: number): number {
  return entry > 0 ? Math.abs(exit - entry) / entry : Infinity;
}
""",
    """function priceMovePct(entry: number, exit: number): number {
  return entry > 0 ? Math.abs(exit - entry) / entry : Infinity;
}

export function stopIsDirectional(entry: number, stop: number, direction: BtcDirection): boolean {
  if (!(entry > 0 && stop > 0)) return false;
  return direction === 'long' ? stop < entry : stop > entry;
}
""",
    'risk directional helper',
)
risk = replace_once(
    risk,
    """  const stopDistancePct = priceMovePct(candidate.preferredEntry, candidate.structuralStop);
  if (!(stopDistancePct > 0 && stopDistancePct < 0.05)) initialReasons.push('structural stop distance is invalid');
""",
    """  const stopDistancePct = priceMovePct(candidate.preferredEntry, candidate.structuralStop);
  if (!stopIsDirectional(candidate.preferredEntry, candidate.structuralStop, candidate.direction)) {
    initialReasons.push('structural stop is on the wrong side of entry');
  }
  if (!(stopDistancePct > 0 && stopDistancePct < 0.05)) initialReasons.push('structural stop distance is invalid');
""",
    'actionable stop validation',
)
risk_path.write_text(risk)


research_path = Path('src/btc/platform/research-risk.ts')
research = research_path.read_text()
research = replace_once(
    research,
    """  CostModelConfig,
  estimateLiquidationPrice,
} from './risk';
""",
    """  CostModelConfig,
  estimateLiquidationPrice,
  stopIsDirectional,
} from './risk';
""",
    'research import',
)
research = replace_once(
    research,
    """  const stopDistancePct = priceMovePct(candidate.preferredEntry, candidate.structuralStop);
  if (!(stopDistancePct > 0 && stopDistancePct < 0.05)) reasons.push('structural stop distance is invalid');
""",
    """  const stopDistancePct = priceMovePct(candidate.preferredEntry, candidate.structuralStop);
  if (!stopIsDirectional(candidate.preferredEntry, candidate.structuralStop, candidate.direction)) {
    reasons.push('structural stop is on the wrong side of entry');
  }
  if (!(stopDistancePct > 0 && stopDistancePct < 0.05)) reasons.push('structural stop distance is invalid');
""",
    'research stop validation',
)
research_path.write_text(research)


strategies_path = Path('src/btc/platform/strategies.ts')
strategies = strategies_path.read_text()
strategies = replace_once(
    strategies,
    """const orderFlowAbsorption: StrategyDefinition = {
  id: 'btc-orderflow-absorption',
  version: '0.1.0-shadow',
""",
    """const orderFlowAbsorption: StrategyDefinition = {
  id: 'btc-orderflow-absorption',
  version: '0.2.0-shadow',
""",
    'strategy version',
)
strategies = replace_once(
    strategies,
    """    const atr = averageTrueRange(candles, 20);
    const entry = currentPrice(context, direction);
    const stop = direction === 'long' ? latest.low - atr * 0.2 : latest.high + atr * 0.2;
    const initialTarget = targetFromRisk(entry, stop, direction, 3.1);
""",
    """    const atr = averageTrueRange(candles, 20);
    const entry = currentPrice(context, direction);
    const rawStop = direction === 'long' ? latest.low - atr * 0.2 : latest.high + atr * 0.2;
    const minimumStopDistance = Math.max(atr * 0.35, entry * 0.00035);
    const stop = direction === 'long'
      ? Math.min(rawStop, entry - minimumStopDistance)
      : Math.max(rawStop, entry + minimumStopDistance);
    const initialTarget = targetFromRisk(entry, stop, direction, 3.1);
""",
    'order-flow stop geometry',
)
strategies = replace_once(
    strategies,
    """      features: { absorption, depth, flow, bookFragility: context.orderFlow.bookFragility, atr },
""",
    """      features: {
        absorption,
        depth,
        flow,
        bookFragility: context.orderFlow.bookFragility,
        atr,
        rawStop,
        minimumStopDistance,
      },
""",
    'order-flow diagnostics',
)
strategies_path.write_text(strategies)
