from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one replacement, found {count}")
    return text.replace(old, new, 1)


engine_path = Path("src/btc/platform/engine.ts")
engine = engine_path.read_text()
engine = replace_once(
    engine,
    "import { assessPortfolioAdmission, DEFAULT_PORTFOLIO_LIMITS, solveRiskPlan } from './risk';\n",
    "import { assessPortfolioAdmission, DEFAULT_PORTFOLIO_LIMITS, solveRiskPlan } from './risk';\n"
    "import { solveResearchRiskPlan } from './research-risk';\n",
    "engine import",
)
engine = replace_once(
    engine,
    """    const fresh: Array<{ candidate: StrategyCandidate; plan: RiskPlan }> = [];
    for (const candidate of candidates) {
      const inserted = await persistCandidate(candidate);
      if (!inserted) continue;
      const plan = solveRiskPlan(context, candidate);
      fresh.push({ candidate, plan });
    }

    const actionable = this.selectActionable(fresh);
    const selectedIds = new Set(actionable.map(item => item.candidate.id));
    for (const item of fresh.filter(item => item.candidate.mode === 'actionable' && !selectedIds.has(item.candidate.id))) {
      await persistRiskDecision(item.candidate, 'actionable', item.plan, ['not selected by duplicate/conflict coordinator']);
    }
    for (const item of actionable) await this.armActionable(item.candidate, item.plan, item.supporting);
    for (const item of fresh) await this.armResearch(item.candidate, item.plan);
""",
    """    const fresh: Array<{
      candidate: StrategyCandidate;
      actionablePlan: RiskPlan;
      researchPlan: RiskPlan;
    }> = [];
    for (const candidate of candidates) {
      const inserted = await persistCandidate(candidate);
      if (!inserted) continue;
      fresh.push({
        candidate,
        actionablePlan: solveRiskPlan(context, candidate),
        researchPlan: solveResearchRiskPlan(context, candidate),
      });
    }

    const actionable = this.selectActionable(fresh.map(item => ({
      candidate: item.candidate,
      plan: item.actionablePlan,
    })));
    const selectedIds = new Set(actionable.map(item => item.candidate.id));
    for (const item of fresh.filter(item => item.candidate.mode === 'actionable' && !selectedIds.has(item.candidate.id))) {
      await persistRiskDecision(
        item.candidate,
        'actionable',
        item.actionablePlan,
        ['not selected by duplicate/conflict coordinator'],
      );
    }
    for (const item of actionable) await this.armActionable(item.candidate, item.plan, item.supporting);
    for (const item of fresh) await this.armResearch(item.candidate, item.researchPlan);
""",
    "engine risk handoff",
)
engine_path.write_text(engine)


dashboard_path = Path("public/btc-dashboard.js")
dashboard = dashboard_path.read_text()
dashboard = replace_once(
    dashboard,
    """        defaultMinimumNetTargetUsd: 20,
        defaultMinimumNetRR: 3,
        maxActionableActiveCalls: 3,
""",
    """        actionableMinimumNetTargetUsd: 20,
        actionableMinimumNetRR: 3,
        researchTargetPolicy: 'strategy_native_realistic_target',
        researchMinimumNetRewardUsd: 'positive_after_estimated_costs',
        researchForcedMinimumNetRR: false,
        researchMaxPlannedLossUsd: 20 / 3,
        maxActionableActiveCalls: 3,
""",
    "dashboard contract",
)
dashboard_path.write_text(dashboard)
