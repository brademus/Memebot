export const MODEL_VERSION = 'forward-v2-20260714';
export const SCORE_SNAPSHOT_AGES_MIN = [3, 5, 10, 15] as const;
export const SCORE_FORWARD_MINUTES = 60;
export const SNAPSHOT_CAPTURE_TOLERANCE_MIN = 0.75;

export function recommendationEligibleSource(source: string): boolean {
  return source !== 'momentum';
}
