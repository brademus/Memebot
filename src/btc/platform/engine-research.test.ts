import assert from 'node:assert/strict';
import test from 'node:test';
import { BtcMultiStrategyEngine, shouldEvaluateResearchFallback } from './engine';

test('armed research blocks duplicate admission without masquerading as an active filled call', () => {
  const engine = new BtcMultiStrategyEngine() as any;
  engine.armed.set('research:candidate-1', {
    book: 'research',
    candidate: { strategyId: 'strategy-1', direction: 'long' },
  });

  assert.equal(engine.strategyHasResearchExposure('strategy-1'), true);
  assert.equal(engine.strategyHasActiveResearch('strategy-1'), false);

  engine.activeCalls = [{
    book: 'research',
    strategyId: 'strategy-1',
    status: 'open',
  }];
  assert.equal(engine.strategyHasActiveResearch('strategy-1'), true);
});

test('a selected actionable candidate falls back to research when later portfolio admission rejects it', () => {
  assert.equal(shouldEvaluateResearchFallback(
    { mode: 'actionable' },
    { approved: true },
    true,
    false,
  ), true);
});

test('an admitted actionable candidate is excluded from the research book', () => {
  assert.equal(shouldEvaluateResearchFallback(
    { mode: 'actionable' },
    { approved: true },
    true,
    true,
  ), false);
});

test('an approved actionable candidate rejected only by duplicate selection remains excluded from duplicate research exposure', () => {
  assert.equal(shouldEvaluateResearchFallback(
    { mode: 'actionable' },
    { approved: true },
    false,
    false,
  ), false);
});

test('shadow and actionable-risk-rejected candidates remain eligible for research evaluation', () => {
  assert.equal(shouldEvaluateResearchFallback(
    { mode: 'shadow' },
    { approved: false },
    false,
    false,
  ), true);
  assert.equal(shouldEvaluateResearchFallback(
    { mode: 'actionable' },
    { approved: false },
    false,
    false,
  ), true);
});
