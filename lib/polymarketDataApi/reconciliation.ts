export const RECONCILIATION_GAP_PASS_PCT = 10;

export function reconciliationGapPercent(
  positionsSum: number,
  headlinePnl: number
): number | null {
  if (
    !Number.isFinite(positionsSum) ||
    !Number.isFinite(headlinePnl) ||
    Math.abs(headlinePnl) < 1
  ) {
    return null;
  }
  const denom = Math.abs(headlinePnl);
  return (Math.abs(positionsSum - headlinePnl) / denom) * 100;
}

export function reconciliationPasses(gapPct: number | null): boolean {
  if (gapPct == null) return false;
  return gapPct <= RECONCILIATION_GAP_PASS_PCT;
}
