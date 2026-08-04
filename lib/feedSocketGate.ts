import { evaluateLiveFeedTradeGate } from "@/lib/feedGate";
import { resolveFeedFilterCategoryLabel } from "@/lib/feedFilterDiagnostics";
import { meetsProductFeedStakeThreshold } from "@/lib/feedQualification";
import { resolveFeedTradeEvPercent } from "@/lib/feedTradeEv";
import {
  fetchPipelineEvBatch,
  fetchPipelineTradeEv,
  pipelineEvKeyForWhale,
} from "@/lib/pipelineEvClient";
import type { SocketTrade } from "@/lib/usePolymarketSocket";
import { tradeToWhale } from "@/lib/whaleTrades";

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

async function resolveSocketTradeEvPercent(
  trade: SocketTrade
): Promise<number | null> {
  const assetId = trade.assetId?.trim();
  if (!assetId) return null;

  const evRequest = {
    source: "polymarket" as const,
    tokenId: assetId,
    tradePrice: trade.price,
  };

  const whale = socketTradeToWhale(trade);
  const key = pipelineEvKeyForWhale(whale);

  const readEvPercent = (
    pipeline: Awaited<ReturnType<typeof fetchPipelineTradeEv>> | undefined
  ) => resolveFeedTradeEvPercent({ price: trade.price }, pipeline ?? null);

  const fetched = await fetchPipelineEvBatch([evRequest]);
  let pipeline: Awaited<ReturnType<typeof fetchPipelineTradeEv>> | undefined =
    key ? fetched.get(key) : undefined;
  let tradeEvPercent = readEvPercent(pipeline);

  if (tradeEvPercent == null) {
    console.log(`[Feed Gate] Enqueued trade ${trade.id} for EV calculation`);
    pipeline = (await fetchPipelineTradeEv(evRequest)) ?? undefined;
    tradeEvPercent = readEvPercent(pipeline);
  }

  return tradeEvPercent;
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

/** Async trade EV gate (+3.0% min on trade-level EV, rejects negative EV). */
export async function passesFeedSocketTradeEvGate(
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

/** Full websocket broadcast gate: $500 stake + calculatedEv >= +3.0%. */
export async function shouldBroadcastQualifiedSocketTrade(
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
