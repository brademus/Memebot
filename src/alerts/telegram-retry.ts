export function telegramRetryDelayMs(
  attemptIndex: number,
  retryAfter: string | null,
  random = Math.random(),
): number {
  if (retryAfter !== null && retryAfter.trim() !== '') {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(60_000, Math.max(500, Math.round(seconds * 1000)));
    }
  }
  const base = Math.min(15_000, 1_000 * 2 ** Math.max(0, attemptIndex));
  const boundedRandom = Math.max(0, Math.min(1, random));
  return Math.max(500, Math.round(base * (0.8 + boundedRandom * 0.4)));
}
