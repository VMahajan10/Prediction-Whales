import "server-only";

export {
  getCachedPolymarketTradeByHash,
  getCachedPolymarketTradesList,
  peekCachedPolymarketTradesList,
} from "@/lib/trades/polymarketTradesCache";

/** Cached Data API trades poll for API routes (not for client bundles). */
export { getCachedPolymarketTradesList as fetchTradesCached } from "@/lib/trades/polymarketTradesCache";
