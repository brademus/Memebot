import assert from 'node:assert/strict';
import test from 'node:test';
import { BtcMultiStrategyEngine } from './engine';

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
