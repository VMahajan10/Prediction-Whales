import type { PipelineTradeEv } from "@/lib/evPipeline/types";
import type { WhaleTrade } from "@/lib/whaleTrades";

/** PM token + Kalshi ticker for arbitrage window lookup on whale feed rows. */
export function resolveArbIdentifiersForWhaleTrade(
  trade: WhaleTrade,
  pipelineData: PipelineTradeEv | null | undefined
): { pmTokenId: string | null; kalshiTicker: string | null } {
  if (trade.source === "kalshi") {
    return {
      pmTokenId: pipelineData?.tokenId ?? null,
      kalshiTicker: trade.ticker ?? pipelineData?.kalshiTicker ?? null,
    };
  }

  return {
    pmTokenId: pipelineData?.tokenId ?? trade.assetId ?? null,
    kalshiTicker: pipelineData?.kalshiTicker ?? null,
  };
}
