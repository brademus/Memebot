import { cfg } from '../config';
import { TokenRecord } from '../types';
import { getStreamMode } from '../ingest/pumpfun';
import { CURVE_FILLED_SOL } from '../constants';

// Shared persistence check — the burst-vs-real discriminator. Applied to BOTH
// Best Buys admission AND the TRIGGER state after the first trigger cohort went
// 0-for-17 (avg 0.51x @1h): alerts were firing at the sniper-burst top, the exact
// moment the research says 85% of early buyers are about to exit.
export function passesPersistence(t: TokenRecord, now = Date.now()): boolean {
  const bb = cfg().bestbuys;
  const ageMin = (now - t.firstSeen) / 60000;
  if (ageMin < bb.min_age_minutes) return false;
  if (t.dex !== 'pumpfun') return true;
  if (t.earlyBuyers.length >= 5) {
    const retention = 1 - t.earlyExited.length / t.earlyBuyers.length;
    if (retention < bb.min_retention) return false;
  }
  // curve inflow check needs RELIABLE curve data. In LITE mode (no funded
  // PumpPortal key) per-trade curve updates are sparse, so a stale sample would
  // false-reject everything — skip it there and lean on retention + age.
  if (getStreamMode() !== 'lite') {
    const ref = t.curveSamples.filter(x => x.at <= now - bb.net_inflow_window_min * 60_000).pop();
    // require the reference to be genuinely recent, not the only sample we ever got
    if (ref && t.curveSamples.length >= 3 && t.curveSol < ref.sol) return false;
    if (t.peakCurveSol > CURVE_FILLED_SOL && t.curveSol < t.peakCurveSol * 0.9) return false;
  }
  return true;
}
