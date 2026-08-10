/** x_post_log.rejection_reason enum values — shared by Drizzle schema and gate logic. */
export const X_POST_REJECTION_REASONS = [
  "KALSHI_PUBLIC_POSTING_DISABLED",
  "BELOW_RESOLVED_BETS",
  "BELOW_EV_THRESHOLD",
  "LOW_EV",
  "STAKE_TOO_LOW",
  "BELOW_STAKE_FLOOR",
  "STALE_TRADE",
  "LINE_DRIFT_EXCEEDED",
  "ILLEGIBLE_MARKET",
  "DUPLICATE_TRADE",
  "RECENT_MARKET_POST",
  "Failed Trade EV (< +3.0%)",
  "Failed Trade EV (< +0.0%)",
  "Failed Trade EV (< +0.1%)",
] as const;

export type XPostRejectionReason = (typeof X_POST_REJECTION_REASONS)[number];
