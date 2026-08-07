import "server-only";

export type { FeedTrade } from "@/lib/feedTradeTypes";
export {
  fetchKalshiTrades,
  type KalshiRawTrade,
} from "@/lib/kalshiTradesServer";
