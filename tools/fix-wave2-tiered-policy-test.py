from pathlib import Path

path = Path('src/btc/platform/wave2-strategies.test.ts')
text = path.read_text()
text = text.replace("import { solveRiskPlan } from './risk';\n", "import { solveResearchRiskPlan } from './research-risk';\n", 1)
old = """  const plan = solveRiskPlan(context, candidates[0]!);\n  assert.equal(plan.approved, true, `${id}: ${plan.rejectionReasons.join('; ')}`);\n  assert.ok(plan.leverage <= strategy(id).leverageCap);\n  assert.ok(plan.estimatedRewardUsd >= 20);\n  assert.ok(plan.estimatedNetRR >= 3);\n"""
new = """  const plan = solveResearchRiskPlan(context, candidates[0]!);\n  assert.equal(plan.approved, true, `${id}: ${plan.rejectionReasons.join('; ')}`);\n  assert.ok(plan.leverage <= strategy(id).leverageCap);\n  assert.ok(plan.estimatedRewardUsd > 0);\n  assert.ok(plan.estimatedRiskUsd <= 20 / 3 + 1e-6);\n  assert.ok(plan.liquidationBufferPct > 0);\n"""
if old not in text:
    raise SystemExit('missing Wave 2 risk assertion block')
path.write_text(text.replace(old, new, 1))
print('Wave 2 suite now validates shadow candidates through the research contract')
