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
  if (t.source === 'aged') return agedPersistenceReady(t, now);
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

export function agedPersistenceReady(t: TokenRecord, now = Date.now()): boolean {
  if (t.source !== 'aged') return true;
  const settings = cfg().aged;
  if (now - t.firstSeen < settings.confirmation_minutes * 60_000) return false;
  const samples = t.marketSamples
    .filter(sample => sample.at >= t.firstSeen && sample.at <= now)
    .slice(-Math.max(settings.confirmation_samples, 30));
  if (samples.length < settings.confirmation_samples) return false;
  const first = samples[0];
  const last = samples[samples.length - 1];
  if (last.at - first.at < settings.confirmation_minutes * 60_000 * 0.75) return false;
  if (!(first.priceUsd > 0) || !(first.liquidityUsd > 0) || !(last.priceUsd > 0) || !(last.liquidityUsd > 0)) return false;

  const priceChangePct = (last.priceUsd / first.priceUsd - 1) * 100;
  const liquidityChangePct = (last.liquidityUsd / first.liquidityUsd - 1) * 100;
  if (priceChangePct < -settings.max_price_pullback_pct) return false;
  if (liquidityChangePct < -settings.max_liquidity_drop_pct) return false;
  if (t.priceChange5m > settings.max_change5m_pct) return false;

  const ratios = samples.map(sample => sample.sells5m > 0
    ? sample.buys5m / sample.sells5m
    : sample.buys5m > 0 ? sample.buys5m : 0).sort((a, b) => a - b);
  const medianRatio = ratios[Math.floor(ratios.length / 2)] || 0;
  const activeSamples = samples.filter(sample => sample.buys5m + sample.sells5m > 0).length;
  return medianRatio >= settings.min_buy_ratio_1h
    && activeSamples >= Math.ceil(settings.confirmation_samples * 0.75);
}
