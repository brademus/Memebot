# Adjust legacy Wave 1 fixtures to the new research economic floor.
from pathlib import Path

path = Path('src/btc/platform/wave1-strategies.test.ts')
text = path.read_text()
anchor = '''function assertResearchOnlyAtThisSetup(context: MarketContext, candidate: StrategyCandidate): void {
  const research = solveResearchRiskPlan(context, candidate);
  assert.equal(research.approved, true, research.rejectionReasons.join('; '));
  assert.ok(research.estimatedRewardUsd > 0);
  const actionable = actionablePlan(context, candidate);
  assert.equal(actionable.approved, false);
  assert.equal(actionable.expectancyEvidence?.ready, true);
  assert.ok(actionable.rejectionReasons.some(reason =>
    reason.includes('standard projected net ROI floor') || reason.includes('standard net reward-to-risk floor'),
  ));
}
'''
addition = anchor + '''
function assertResearchQuarantined(context: MarketContext, candidate: StrategyCandidate): void {
  const research = solveResearchRiskPlan(context, candidate);
  assert.equal(research.approved, false);
  assert.ok(research.rejectionReasons.some(reason => reason.includes('quality floor')));
  const actionable = actionablePlan(context, candidate);
  assert.equal(actionable.approved, false);
}
'''
if anchor not in text:
    raise RuntimeError('research helper anchor missing')
text = text.replace(anchor, addition, 1)

for title in [
    "test('Donchian strategy emits a valid research candidate that is filtered when this setup misses the standard ROI floor'",
    "test('price-OI state machine emits a valid research candidate that is filtered when this setup misses the standard tier'",
]:
    start = text.find(title)
    if start < 0:
        raise RuntimeError(f'missing test {title}')
    end = text.find('\n});', start)
    if end < 0:
        raise RuntimeError(f'missing end for {title}')
    block = text[start:end]
    if 'assertResearchOnlyAtThisSetup(context, candidates[0]!);' not in block:
        raise RuntimeError(f'missing research assertion in {title}')
    block = block.replace(
        'assertResearchOnlyAtThisSetup(context, candidates[0]!);',
        'assertResearchQuarantined(context, candidates[0]!);',
        1,
    )
    text = text[:start] + block + text[end:]

text = text.replace(
    "test('Donchian strategy emits a valid research candidate that is filtered when this setup misses the standard ROI floor'",
    "test('Donchian signal is quarantined when native economics miss the research quality floor'",
)
text = text.replace(
    "test('price-OI state machine emits a valid research candidate that is filtered when this setup misses the standard tier'",
    "test('price-OI signal is quarantined when native economics miss the research quality floor'",
)
path.write_text(text)
print('Wave 1 refinement tests adjusted')
