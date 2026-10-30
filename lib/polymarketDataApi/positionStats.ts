import type { V2PositionRow } from "@/lib/polymarketDataApi/types";

export interface RealizedPnlSignTally {
  total: number;
  positive: number;
  negative: number;
  zero: number;
  /** Losing CLOSED rows with redeemable=false (resolved loss, not yet redeemed). */
  negativeNotRedeemable: number;
}

export function tallyClosedRealizedPnlSigns(
  rows: V2PositionRow[]
): RealizedPnlSignTally {
  let positive = 0;
  let negative = 0;
  let zero = 0;
  let negativeNotRedeemable = 0;
  for (const r of rows) {
    const rp = Number(r.realized_pnl ?? 0);
    if (rp > 0) positive++;
    else if (rp < 0) {
      negative++;
      if (!r.redeemable) negativeNotRedeemable++;
    } else zero++;
  }
  return {
    total: rows.length,
    positive,
    negative,
    zero,
    negativeNotRedeemable,
  };
}
