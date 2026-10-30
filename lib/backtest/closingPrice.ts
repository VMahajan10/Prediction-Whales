import type { PricePoint } from "@/lib/clvPriceHistory";

export type ClosingPriceExclusionReason =
  | "no_history"
  | "no_point_before_close"
  | "invalid_close_time";

const SETTLEMENT_EPS = 0.02;

export interface TokenClosingPriceResult {
  closingLine: number | null;
  /** Unix seconds of the price point used as the closing midpoint. */
  closeTimestamp: number | null;
  valid: boolean;
  reason?: ClosingPriceExclusionReason;
}

/**
 * Last traded midpoint for this outcome token at or before `closeTimestampSec`.
 * No default/fallback price — invalid when history or a pre-close point is missing.
 */
export function lastMidpointBeforeClose(
  series: PricePoint[],
  closeTimestampSec: number
): TokenClosingPriceResult {
  if (!Number.isFinite(closeTimestampSec) || closeTimestampSec <= 0) {
    return {
      closingLine: null,
      closeTimestamp: null,
      valid: false,
      reason: "invalid_close_time",
    };
  }

  if (!series?.length) {
    return {
      closingLine: null,
      closeTimestamp: null,
      valid: false,
      reason: "no_history",
    };
  }

  const sorted = [...series].sort((a, b) => a.t - b.t);
  const beforeClose = sorted.filter((pt) => pt.t <= closeTimestampSec);

  if (beforeClose.length === 0) {
    return {
      closingLine: null,
      closeTimestamp: null,
      valid: false,
      reason: "no_point_before_close",
    };
  }

  const active = beforeClose.filter(
    (pt) => pt.p > SETTLEMENT_EPS && pt.p < 1 - SETTLEMENT_EPS
  );
  const pool = active.length > 0 ? active : beforeClose;
  const last = pool[pool.length - 1];

  if (!Number.isFinite(last.p) || last.p <= 0) {
    return {
      closingLine: null,
      closeTimestamp: null,
      valid: false,
      reason: "no_history",
    };
  }

  return {
    closingLine: last.p,
    closeTimestamp: last.t,
    valid: true,
  };
}
