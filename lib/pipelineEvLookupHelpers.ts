import {
  normalizeKalshiTicker,
  normalizePmTokenId,
  pipelineEvLookupAliases,
} from "@/lib/evPipeline/crossAssetLookup";
import type { PipelineTradeEv } from "@/lib/evPipeline/types";
import {
  pipelineEvLookupKeyKalshi,
  pipelineEvLookupKeyPm,
} from "@/lib/evPipeline/types";
import { normalizeIncomingTradePrice } from "@/lib/evPipeline/tradeEvRecord";
import type { FeedTrade } from "@/lib/feedTradeTypes";
import type { WhaleTrade } from "@/lib/whaleTrades";

/** Canonical pm:/kalshi: lookup key — matches Cross-Venue Lock scanner normalization. */
export function pipelineEvKeyForTrade(trade: FeedTrade): string | null {
  if (trade.source === "polymarket" && trade.assetId) {
    const tokenId = normalizePmTokenId(trade.assetId);
    return tokenId ? pipelineEvLookupKeyPm(tokenId) : null;
  }
  if (trade.source === "kalshi" && trade.ticker) {
    const ticker = normalizeKalshiTicker(trade.ticker);
    return ticker ? pipelineEvLookupKeyKalshi(ticker) : null;
  }
  return null;
}

/** Canonical pm:/kalshi: lookup key — matches Cross-Venue Lock scanner normalization. */
export function pipelineEvKeyForWhale(trade: WhaleTrade): string | null {
  const platform = (trade.platform ?? trade.source ?? "").toLowerCase();
  if (platform === "polymarket" && trade.assetId) {
    const tokenId = normalizePmTokenId(trade.assetId);
    return tokenId ? pipelineEvLookupKeyPm(tokenId) : null;
  }
  if (platform === "kalshi" && trade.ticker) {
    const ticker = normalizeKalshiTicker(trade.ticker);
    return ticker ? pipelineEvLookupKeyKalshi(ticker) : null;
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

  const normalizedKalshiTicker = normalizeKalshiTicker(aliases?.kalshiTicker);
  const normalizedTokenId = normalizePmTokenId(aliases?.tokenId);

  const direct = index.get(lookupKey);
  if (direct) return direct;

  for (const alias of pipelineEvLookupAliases({
    key: lookupKey,
    tokenId: normalizedTokenId,
    kalshiTicker: normalizedKalshiTicker,
  })) {
    const hit = index.get(alias);
    if (hit) return hit;
  }

  return null;
}

/**
 * When the batch EV index misses a Kalshi row, synthesize a minimal pipeline
 * payload from stamped trade EV so feed gates do not reject on "missing" alone.
 */
function synthesizeKalshiPipelineFromTrade(
  trade: WhaleTrade,
  lookupKey: string
): PipelineTradeEv | null {
  const ticker = normalizeKalshiTicker(trade.ticker);
  if (!ticker) return null;

  const entry = normalizeIncomingTradePrice(trade.price);
  if (entry == null || entry <= 0) return null;

  if (trade.netEvPercent != null && Number.isFinite(trade.netEvPercent)) {
    return {
      key: lookupKey,
      status: "ok",
      tokenId: null,
      kalshiTicker: ticker,
      netEvPercent: trade.netEvPercent,
      netEv: trade.netEvPercent / 100,
      grossEvPercent: trade.grossEvPercent ?? null,
      averageEv: trade.averageEv ?? trade.netEvPercent,
      pTrue: null,
      pMarket: null,
      pmMid: null,
      kalshiMid: null,
      pTrueSource: "execution_price",
      pTrueConfidence: null,
      pTrueLowConfidence: true,
    };
  }

  return null;
}

/** Resolve pipeline EV for a whale row — same alias rules as the Cross-Venue Lock scanner. */
export function resolvePipelineEvForWhale(
  index: Map<string, PipelineTradeEv>,
  trade: WhaleTrade
): PipelineTradeEv | null {
  const key = pipelineEvKeyForWhale(trade);
  if (!key) return null;

  const platform = (trade.platform ?? trade.source ?? "").toLowerCase();
  const pipeline = resolvePipelineEvFromIndex(index, key, {
    tokenId: platform === "polymarket" ? trade.assetId ?? null : null,
    kalshiTicker: platform === "kalshi" ? trade.ticker ?? null : null,
  });
  if (pipeline) return pipeline;

  if (platform === "kalshi") {
    return synthesizeKalshiPipelineFromTrade(trade, key);
  }

  return null;
}
