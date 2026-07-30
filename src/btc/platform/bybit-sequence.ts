export interface OrderbookSequenceDecision {
  current: number | null;
  accept: boolean;
  reset: boolean;
  gap: boolean;
}

export function assessOrderbookSequence(
  previous: number | null,
  messageType: unknown,
  updateId: unknown,
): OrderbookSequenceDecision {
  const current = Number(updateId);
  const valid = Number.isSafeInteger(current) && current > 0;
  const snapshot = messageType === 'snapshot' || current === 1;

  if (!valid) {
    return { current: previous, accept: false, reset: false, gap: messageType !== 'snapshot' };
  }
  if (snapshot) {
    return { current, accept: true, reset: true, gap: false };
  }
  if (previous === null) {
    return { current: null, accept: false, reset: false, gap: true };
  }
  if (current <= previous) {
    return { current: previous, accept: false, reset: false, gap: false };
  }
  if (current > previous + 1) {
    return { current: null, accept: false, reset: false, gap: true };
  }
  return { current, accept: true, reset: false, gap: false };
}
