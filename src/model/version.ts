export const MODEL_VERSION = 'signal-v3-20260714';

// Clock-time checkpoints remain useful for comparable cohorts, but v3 also records
// curve-state milestones in signal_observations. The early checkpoints matter because
// successful pump.fun launches often complete the important part of their lifecycle
// before a conventional 10-15 minute snapshot.
export const SCORE_SNAPSHOT_AGES_MIN = [1, 2, 3, 5, 10, 15] as const;
export const SCORE_FORWARD_MINUTES = 60;
export const SNAPSHOT_CAPTURE_TOLERANCE_MIN = 0.75;
export const SIGNAL_FORWARD_HORIZONS_MIN = [15, 60, 240] as const;
export const CURVE_MILESTONES = [0.25, 0.5, 0.75, 0.9] as const;
export const DECISION_MAX_AGE_MS = 45_000;

export function recommendationEligibleSource(source: string): boolean {
  return source !== 'momentum';
}
