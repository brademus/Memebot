from pathlib import Path
import re

cvd = Path('src/btc/platform/wave2/cvd-divergence.ts')
text = cvd.read_text().replace('if (candles.length < 36) return [];', 'if (candles.length < 30) return [];')
cvd.write_text(text)

research = Path('src/btc/platform/research-risk.test.ts')
text = research.read_text().replace(
    "candidate({ strategyLeverageCap: 12 })",
    "candidate({ strategyLeverageCap: 12, initialTarget: 101_000, maximumRealisticTarget: 101_000 })",
)
research.write_text(text)

wave2 = Path('src/btc/platform/wave2-strategies.test.ts')
text = wave2.read_text()
old = re.compile(r"function assertShadowCandidatePassesRisk\(context: MarketContext, id: string\) \{.*?\n\}", re.S)
new = '''function assertShadowCandidatePassesRisk(context: MarketContext, id: string, shouldApprove = true) {
  const candidates = strategy(id).evaluate(context);
  assert.equal(candidates.length, 1, `${id} did not emit`);
  assert.equal(candidates[0]!.mode, 'shadow');
  const plan = solveResearchRiskPlan(context, candidates[0]!);
  assert.equal(plan.approved, shouldApprove, `${id}: ${plan.rejectionReasons.join('; ')}`);
  if (shouldApprove) {
    assert.ok(plan.leverage <= strategy(id).leverageCap);
    assert.ok(plan.estimatedRewardUsd > 0);
    assert.ok(plan.estimatedNetRR >= 1.5);
    assert.ok(plan.estimatedTargetRoiPct >= 4);
    assert.ok(plan.estimatedRiskUsd <= 20 / 3 + 1e-6);
    assert.ok(plan.liquidationBufferPct > 0);
  } else {
    assert.ok(plan.rejectionReasons.some(reason => reason.includes('quality floor')));
  }
  return candidates[0]!;
}'''
text, count = old.subn(new, text, count=1)
if count != 1:
    raise RuntimeError(f'expected helper replacement, got {count}')
text = text.replace(
    "test('microprice scalper emits only when microprice, book depth and aggressive flow align', () => {",
    "test('microprice signal remains observable but weak native economics are quarantined', () => {",
)
text = text.replace(
    "const candidate = assertShadowCandidatePassesRisk(context, 'btc-microprice-orderbook-scalper');",
    "const candidate = assertShadowCandidatePassesRisk(context, 'btc-microprice-orderbook-scalper', false);",
)
text = text.replace(
    "test('ETH-led catch-up emits when ETH leads and BTC flow starts following', () => {",
    "test('ETH-led signal remains observable but weak native economics are quarantined', () => {",
)
text = text.replace(
    "const candidate = assertShadowCandidatePassesRisk(context, 'btc-eth-led-catch-up');",
    "const candidate = assertShadowCandidatePassesRisk(context, 'btc-eth-led-catch-up', false);",
)
wave2.write_text(text)

print('BTC refinement finalizer applied')
