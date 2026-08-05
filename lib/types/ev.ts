/** Client-safe EV request shape — shared by browser fetch and server resolver. */
export interface PipelineEvRequestItem {
  source: "polymarket" | "kalshi";
  tokenId?: string;
  kalshiTicker?: string;
  tradePrice?: number;
}

export type {
  PipelineTradeEv,
  PipelineTradeEvInput,
  PipelineTradeEvStatus,
} from "@/lib/evPipeline/types";
