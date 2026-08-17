import { pipelineEvLookupAliases } from "@/lib/evPipeline/crossAssetLookup";
import type { PipelineTradeEv } from "@/lib/evPipeline/types";
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

/** Resolve a pipeline EV row from a batch index using pm:/kalshi:/pair: aliases. */
export function resolvePipelineEvFromIndex(
  index: Map<string, PipelineTradeEv>,
  lookupKey: string | null | undefined,
  aliases?: { tokenId?: string | null; kalshiTicker?: string | null }
): PipelineTradeEv | null {
  if (!lookupKey?.trim()) return null;

  const direct = index.get(lookupKey);
  if (direct) return direct;

  for (const alias of pipelineEvLookupAliases({
    key: lookupKey,
    tokenId: aliases?.tokenId ?? null,
    kalshiTicker: aliases?.kalshiTicker ?? null,
  })) {
    const hit = index.get(alias);
    if (hit) return hit;
  }

  return null;
}
