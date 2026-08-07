import {
  pipelineEvLookupKeyKalshi,
  pipelineEvLookupKeyPm,
} from "@/lib/evPipeline/types";
import type { FeedTrade } from "@/lib/feedTradeTypes";
import type { WhaleTrade } from "@/lib/whaleTrades";

export function pipelineEvKeyForTrade(trade: FeedTrade): string | null {
  if (trade.source === "polymarket" && trade.assetId) {
    return pipelineEvLookupKeyPm(trade.assetId);
  }
  if (trade.source === "kalshi" && trade.ticker) {
    return pipelineEvLookupKeyKalshi(trade.ticker);
  }
  return null;
}

export function pipelineEvKeyForWhale(trade: WhaleTrade): string | null {
  const platform = (trade.platform ?? trade.source ?? "").toLowerCase();
  if (platform === "polymarket" && trade.assetId) {
    return pipelineEvLookupKeyPm(trade.assetId);
  }
  if (platform === "kalshi" && trade.ticker) {
    return pipelineEvLookupKeyKalshi(trade.ticker);
  }
  return null;
}
