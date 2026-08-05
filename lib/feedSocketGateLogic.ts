/**
 * Pure feed socket gate logic — no `server-only`, no pipeline EV fetchers.
 * Wired by `feedSocketGateClient` (browser) and `feedSocketGateWorker` (Render).
 */
import { evaluateLiveFeedTradeGate } from "@/lib/feedGate";
import { resolveFeedFilterCategoryLabel } from "@/lib/feedFilterDiagnostics";
import { meetsProductFeedStakeThreshold } from "@/lib/feedQualification";
import { resolveFeedTradeEvPercent } from "@/lib/feedTradeEv";
import { pipelineEvKeyForWhale } from "@/lib/pipelineEvLookupHelpers";
import type { SocketTrade } from "@/lib/types/socket";
import type { PipelineEvRequestItem, PipelineTradeEv } from "@/lib/types/ev";
import { tradeToWhale } from "@/lib/whaleTrades";

export type PipelineEvBatchFetcher = (
  items: PipelineEvRequestItem[]
) => Promise<Map<string, PipelineTradeEv>>;

export type PipelineEvSingleFetcher = (
  item: PipelineEvRequestItem
) => Promise<PipelineTradeEv | null>;

function socketTradeToWhale(trade: SocketTrade) {
  return tradeToWhale(
    {
      id: trade.id,
      title: trade.title,
      side: trade.side,
      outcome: trade.outcome,
      price: trade.price,
      size: trade.size,
      timestamp: trade.timestamp,
      transactionHash: trade.transactionHash,
      assetId: trade.assetId,
      eventSlug: trade.eventSlug,
      slug: trade.slug,
      conditionId: trade.conditionId,
    },
    { usdNotional: trade.usdNotional, source: "polymarket", isLive: true }
  );
}

export async function resolveSocketTradeEvPercentWith(
  trade: SocketTrade,
  fetchBatch: PipelineEvBatchFetcher,
  fetchSingle: PipelineEvSingleFetcher
): Promise<number | null> {
  const assetId = trade.assetId?.trim();
  if (!assetId) return null;

  const evRequest: PipelineEvRequestItem = {
    source: "polymarket",
    tokenId: assetId,
    tradePrice: trade.price,
  };

  const whale = socketTradeToWhale(trade);
  const key = pipelineEvKeyForWhale(whale);

  const readEvPercent = (pipeline: PipelineTradeEv | null | undefined) =>
    resolveFeedTradeEvPercent({ price: trade.price }, pipeline ?? null);

  try {
    const fetched = await fetchBatch([evRequest]);
    let pipeline: PipelineTradeEv | null | undefined = key
      ? fetched.get(key)
      : undefined;
    let tradeEvPercent = readEvPercent(pipeline);

    if (tradeEvPercent == null) {
      console.log(`[Feed Gate] Enqueued trade ${trade.id} for EV calculation`);
      pipeline = (await fetchSingle(evRequest)) ?? undefined;
      tradeEvPercent = readEvPercent(pipeline);
    }

    return tradeEvPercent;
  } catch (err) {
    console.warn(
      "[Feed Gate] EV resolution failed — treating as missing EV",
      trade.id,
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

function buildSocketFeedTrade(
  trade: SocketTrade,
  tradeEvPercent: number | null
) {
  return {
    stakeUsd: trade.usdNotional,
    title: trade.title,
    slug: trade.slug,
    eventSlug: trade.eventSlug,
    category: resolveFeedFilterCategoryLabel(trade),
    tradeEvPercent,
  };
}

function logMissingAssetReject(trade: SocketTrade): void {
  console.log(
    `[Feed Gate Reject] id=${trade.id} | source=socket | calculatedEv=N/A | stake=$${trade.usdNotional.toFixed(2)} | notional=$${trade.usdNotional.toFixed(2)} | reason=missing_asset (no assetId for EV lookup)`
  );
}

/** Product feed stake gate — flat $500 minimum. */
export function passesFeedSocketStakeGate(trade: SocketTrade): boolean {
  return meetsProductFeedStakeThreshold(trade.usdNotional);
}

export function createFeedSocketGateHandlers(
  fetchBatch: PipelineEvBatchFetcher,
  fetchSingle: PipelineEvSingleFetcher
) {
  async function resolveSocketTradeEvPercent(
    trade: SocketTrade
  ): Promise<number | null> {
    return resolveSocketTradeEvPercentWith(trade, fetchBatch, fetchSingle);
  }

  async function passesFeedSocketTradeEvGate(
    trade: SocketTrade
  ): Promise<boolean> {
    if (!trade.assetId?.trim()) {
      logMissingAssetReject(trade);
      return false;
    }

    const tradeEvPercent = await resolveSocketTradeEvPercent(trade);
    return evaluateLiveFeedTradeGate(buildSocketFeedTrade(trade, tradeEvPercent), {
      id: trade.id,
      source: "socket",
    }).passed;
  }

  async function shouldBroadcastQualifiedSocketTrade(
    trade: SocketTrade
  ): Promise<boolean> {
    if (!trade.assetId?.trim()) {
      logMissingAssetReject(trade);
      return false;
    }

    const tradeEvPercent = await resolveSocketTradeEvPercent(trade);
    return evaluateLiveFeedTradeGate(buildSocketFeedTrade(trade, tradeEvPercent), {
      id: trade.id,
      source: "socket",
    }).passed;
  }

  return {
    passesFeedSocketTradeEvGate,
    shouldBroadcastQualifiedSocketTrade,
  };
}
