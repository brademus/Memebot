import { TokenRecord } from '../types';
import { assessEntryTiming, ConvictionQueueStatus } from './conviction-queue';

// Compatibility surface for older diagnostics. Conviction is now a pre-alert queue
// state; there is no second post-buy conviction alert or separate daily budget.
export interface ConvictionResult {
  pass: boolean;
  confirmed: string[];
  missing: string[];
}

export function checkConviction(
  token: TokenRecord,
  now = Date.now(),
  override?: ConvictionQueueStatus,
): ConvictionResult {
  const timing = assessEntryTiming(token, now, override);
  const confirmed: string[] = [];
  if (timing.conviction.queued) confirmed.push(`selected in ${timing.conviction.lane} conviction lane`);
  if (timing.conviction.holdReady) confirmed.push(`conviction held ${Math.round(timing.conviction.heldSeconds)}s`);
  if (timing.persistenceReady) confirmed.push('buyer persistence confirmed');
  if (timing.burstCooled) confirmed.push('entry is not chasing an extreme five-minute spike');
  if (timing.evidenceReady) confirmed.push('trade and buyer evidence is sufficient');
  return { pass: timing.ready, confirmed, missing: timing.blockers };
}

export function consumeBudget() { /* retired: one buy alert per token */ }
export function convictionFiredToday() { return 0; }
