/** Reconciliation tolerance vs Polymarket profile Total PnL. */
export const PROFILE_PNL_RECONCILIATION_TOLERANCE = 0.05;

export function ledgerNetWithinProfileTolerance(
  ledgerNetPnl: number,
  profileTotalPnl: number,
  tolerance = PROFILE_PNL_RECONCILIATION_TOLERANCE
): boolean {
  if (!Number.isFinite(ledgerNetPnl) || !Number.isFinite(profileTotalPnl)) {
    return false;
  }
  const denom = Math.max(Math.abs(profileTotalPnl), 1);
  return Math.abs(ledgerNetPnl - profileTotalPnl) / denom <= tolerance;
}
