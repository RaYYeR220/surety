// Whole-percent weights for a vote split, so a ballot always adds up to exactly 100.

/** Splits 100 in proportion to `parts` (largest remainder); an even split when they are all zero. */
export function percentSplit(parts: readonly number[]): number[] {
  if (parts.length === 0) return [];
  const total = parts.reduce((a, b) => a + Math.max(0, b), 0);
  const shares = total > 0 ? parts.map((p) => (Math.max(0, p) / total) * 100) : parts.map(() => 100 / parts.length);
  const floors = shares.map(Math.floor);
  let left = 100 - floors.reduce((a, b) => a + b, 0);
  const order = shares
    .map((s, i) => ({ i, rest: s - Math.floor(s) }))
    .sort((a, b) => b.rest - a.rest || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    floors[i]! += 1;
    left -= 1;
  }
  return floors;
}

/** Whether every weight is a whole percent from 1 to 100 and they add up to 100. */
export function weightsValid(weights: readonly number[]): boolean {
  return (
    weights.length > 0 &&
    weights.every((w) => Number.isInteger(w) && w >= 1 && w <= 100) &&
    weights.reduce((a, b) => a + b, 0) === 100
  );
}
