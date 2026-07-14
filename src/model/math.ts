export const clamp01 = (value: number) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
export const round = (value: number, digits = 4) => {
  const scale = 10 ** digits;
  return Math.round((Number.isFinite(value) ? value : 0) * scale) / scale;
};
export const sigmoid = (value: number) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, value))));

export function softmax(values: Record<string, number>): Record<string, number> {
  const entries = Object.entries(values);
  const maximum = Math.max(...entries.map(([, value]) => value));
  const exp = entries.map(([key, value]) => [key, Math.exp(value - maximum)] as const);
  const total = exp.reduce((sum, [, value]) => sum + value, 0) || 1;
  return Object.fromEntries(exp.map(([key, value]) => [key, value / total]));
}

export function mean(values: number[]): number {
  const finite = values.filter(Number.isFinite);
  return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : 0;
}

export function standardDeviation(values: number[]): number {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(mean(values.map(value => (value - average) ** 2)));
}

export function percentile(values: number[], p: number): number {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const position = clamp01(p) * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

export function normalizedEntropy(values: string[]): number {
  if (values.length < 2) return values.length ? 1 : 0;
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  if (counts.size <= 1) return 0;
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / values.length;
    entropy -= probability * Math.log(probability);
  }
  return clamp01(entropy / Math.log(counts.size));
}

export function brierScore(probabilities: number[], labels: number[]): number {
  if (!probabilities.length || probabilities.length !== labels.length) return 0;
  return mean(probabilities.map((probability, index) => (clamp01(probability) - clamp01(labels[index])) ** 2));
}

export function deterministicShuffle<T>(values: T[], seed = 17): T[] {
  const result = [...values];
  let state = seed >>> 0;
  const random = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
  for (let index = result.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}
