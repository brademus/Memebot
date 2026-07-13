// The weighted-subscore/2x tuner is intentionally retired. Raw-v1 calibration is
// the single authoritative scoring learner; keeping two incompatible objectives
// produced suggestions the live six-feature model could not faithfully express.

let latest: any = {
  status: 'retired',
  reason: 'raw_v1_score_calibrator_is_authoritative',
  weights: null,
  at: new Date().toISOString(),
};

export function startAutotune() {
  latest = {
    status: 'retired',
    reason: 'raw_v1_score_calibrator_is_authoritative',
    weights: null,
    at: new Date().toISOString(),
  };
  console.log('[autotune] legacy weighted-subscore tuner retired; raw-v1 calibrator owns scoring');
}

export const latestSuggestion = () => latest;
