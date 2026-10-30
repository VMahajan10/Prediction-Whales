import type { V2PositionRow } from "@/lib/polymarketDataApi/types";

const TERMINAL_PRICE_EPS = 0.001;

/** Extend API row with pricing fields used for resolution detection. */
export type V2PositionRowWithPrice = V2PositionRow & {
  current_price?: number;
  current_value?: number;
  percent_pnl?: number;
};

export function isTerminalMarketPrice(price: number | undefined | null): boolean {
  if (price == null || !Number.isFinite(price)) return false;
  return price <= TERMINAL_PRICE_EPS || price >= 1 - TERMINAL_PRICE_EPS;
}

/** OPEN/REDEEMABLE row on a market that has settled (price at 0 or 1). */
export function isResolvedNonClosedPosition(
  row: V2PositionRowWithPrice
): boolean {
  const status = String(row.status ?? "").toUpperCase();
  if (status !== "OPEN" && status !== "REDEEMABLE") return false;
  return isTerminalMarketPrice(row.current_price);
}

/** PnL contribution for reconciliation vs headline realized PnL. */
export function reconciliationPnlContribution(
  row: V2PositionRowWithPrice
): number {
  const status = String(row.status ?? "").toUpperCase();
  if (status === "CLOSED") {
    return Number(row.realized_pnl ?? 0);
  }
  if (isResolvedNonClosedPosition(row)) {
    return Number(row.total_pnl ?? 0);
  }
  return 0;
}

/**
 * Variant: only add resolved OPEN/REDEEMABLE when realized_pnl is ~0
 * (avoids double-counting wins already rolled into CLOSED rows).
 */
export function reconciliationPnlContributionAvoidDoubleCount(
  row: V2PositionRowWithPrice
): number {
  const status = String(row.status ?? "").toUpperCase();
  if (status === "CLOSED") {
    return Number(row.realized_pnl ?? 0);
  }
  if (!isResolvedNonClosedPosition(row)) return 0;
  const realized = Number(row.realized_pnl ?? 0);
  if (Math.abs(realized) > 1e-6) return 0;
  return Number(row.total_pnl ?? 0);
}

export function sumReconciliationPnlAvoidDoubleCount(
  rows: V2PositionRowWithPrice[]
): number {
  let sum = 0;
  for (const row of rows) {
    sum += reconciliationPnlContributionAvoidDoubleCount(row);
  }
  return sum;
}

export function sumReconciliationPnl(rows: V2PositionRowWithPrice[]): number {
  let sum = 0;
  for (const row of rows) {
    sum += reconciliationPnlContribution(row);
  }
  return sum;
}

/** PF position row: CLOSED uses realized_pnl; resolved OPEN/REDEEMABLE uses total_pnl. */
export function profitFactorPnlFromRow(
  row: V2PositionRowWithPrice
): number | null {
  const status = String(row.status ?? "").toUpperCase();
  if (status === "CLOSED") {
    return Number(row.realized_pnl ?? 0);
  }
  if (isResolvedNonClosedPosition(row)) {
    const realized = Number(row.realized_pnl ?? 0);
    if (Math.abs(realized) > 1e-6) return null;
    return Number(row.total_pnl ?? 0);
  }
  return null;
}

export function collectProfitFactorPnlRows(
  rows: V2PositionRowWithPrice[]
): number[] {
  const out: number[] = [];
  for (const row of rows) {
    const pnl = profitFactorPnlFromRow(row);
    if (pnl != null && Number.isFinite(pnl)) out.push(pnl);
  }
  return out;
}

export interface ResolvedOpenRedeemableSummary {
  count: number;
  sumTotalPnl: number;
  sumRealizedPnl: number;
  sumCurrentValue: number;
  samplePrices: number[];
}

export function summarizeResolvedOpenRedeemable(
  rows: V2PositionRowWithPrice[]
): ResolvedOpenRedeemableSummary {
  let count = 0;
  let sumTotalPnl = 0;
  let sumRealizedPnl = 0;
  let sumCurrentValue = 0;
  const samplePrices: number[] = [];
  for (const row of rows) {
    if (!isResolvedNonClosedPosition(row)) continue;
    count++;
    sumTotalPnl += Number(row.total_pnl ?? 0);
    sumRealizedPnl += Number(row.realized_pnl ?? 0);
    sumCurrentValue += Number(row.current_value ?? 0);
    if (samplePrices.length < 5) {
      samplePrices.push(Number(row.current_price ?? 0));
    }
  }
  return {
    count,
    sumTotalPnl,
    sumRealizedPnl,
    sumCurrentValue,
    samplePrices,
  };
}
