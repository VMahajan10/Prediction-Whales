import type { TradeSummary } from "@/lib/polymarket";

type TradeWithMeta = TradeSummary & {
  source?: "polymarket" | "kalshi";
  traceable?: boolean;
};

const PM_TX_HASH = /^0x[a-fA-F0-9]{64}$/;

/** True for on-chain Polymarket trades; false for Kalshi or non-traceable feed rows. */
export function isPolymarketTrade(trade: TradeSummary): boolean {
  const t = trade as TradeWithMeta;
  if (t.source === "kalshi") return false;
  if (t.traceable === false) return false;
  return PM_TX_HASH.test(trade.transactionHash ?? "");
}
