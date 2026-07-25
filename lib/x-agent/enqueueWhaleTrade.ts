import { randomUUID } from "node:crypto";
import type { XPostQueue } from "@/lib/crossmarket/store/schema";
import { coalesceDisplayEvPercent } from "@/lib/evPipeline/tradeEvRecord";
import { ensureFullyComputedTradeEv } from "@/lib/evPipeline/resolveTradeEv";
import {
  pipelineEvLookupKey,
  type PipelineTradeEvInput,
} from "@/lib/evPipeline/types";
import { getPrisma, isPrismaEnabled } from "@/lib/prisma";
import type { WhaleTrade } from "@/lib/whaleTrades";
import {
  evaluateTradeEligibility,
  type TradePayload,
} from "@/lib/x-agent/gates";
import {
  type GateSummary,
  HIGH_EV_TRADE_THRESHOLD_PCT,
  recordQueuedSuccess,
  recordTradeEvaluated,
} from "@/lib/x-agent/gateMetrics";
import { dispatchAdminReviewAlert } from "@/lib/x-agent/notifications";
import { generateXPostCopy } from "@/lib/x-agent/templates";
import {
  ensureWhaleInRegistry,
  findWhaleByWallet,
  normalizeWalletAddress,
} from "@/lib/x-agent/whaleRegistryDb";

export { HIGH_EV_TRADE_THRESHOLD_PCT } from "@/lib/x-agent/gateMetrics";

function logEnqueueSkip(trade: WhaleTrade, message: string): void {
  console.log(message);
}

function whaleToEvInput(trade: WhaleTrade): PipelineTradeEvInput | null {
  if (trade.source === "polymarket" && trade.assetId) {
    return {
      source: "polymarket",
      tokenId: trade.assetId,
      tradePrice: trade.price,
      title: trade.title,
      slug: trade.slug ?? trade.eventSlug ?? undefined,
    };
  }

  if (trade.source === "kalshi" && trade.ticker) {
    return {
      source: "kalshi",
      kalshiTicker: trade.ticker,
      tradePrice: trade.price,
      title: trade.title,
    };
  }

  return null;
}

function resolveMarketSlug(trade: WhaleTrade): string {
  return (
    trade.slug?.trim() ||
    trade.eventSlug?.trim() ||
    trade.conditionId?.trim() ||
    `trade-${trade.id}`
  );
}

function priceToCents(price: number): number {
  const normalized = price > 1 && price <= 100 ? price : price * 100;
  return Math.round(normalized);
}

function buildTradePayload(
  trade: WhaleTrade,
  walletAddress: string,
  nowCents: number
): TradePayload {
  const entryCents = priceToCents(trade.price);

  return {
    source: trade.source,
    tradeId: trade.id,
    walletAddress,
    stakeNotional: trade.usdNotional,
    timestamp: trade.timestamp,
    entryCents,
    nowCents,
    title: trade.title,
    outcome: trade.outcome,
    side: trade.side,
    marketSlug: resolveMarketSlug(trade),
    slug: trade.slug ?? null,
    eventSlug: trade.eventSlug ?? null,
  };
}

/**
 * High-EV whale ingestion hook: resolve trade EV, auto-register unknown wallets
 * in WhaleRegistry via Prisma, then enqueue an X post draft when all gates pass.
 */
export async function processWhaleTradeForXAgent(
  trade: WhaleTrade,
  metrics?: GateSummary
): Promise<void> {
  if (metrics) {
    recordTradeEvaluated(metrics);
  }

  const wallet = trade.proxyWallet?.trim();
  const evInput = whaleToEvInput(trade);
  const lookupKey = evInput ? pipelineEvLookupKey(evInput) : null;

  let tradeEvPercent: number | null = null;
  let pipelinePmMid: number | null = null;
  if (evInput && lookupKey) {
    const pipelineEv = await ensureFullyComputedTradeEv(lookupKey, evInput);
    tradeEvPercent = coalesceDisplayEvPercent(pipelineEv);
    pipelinePmMid = pipelineEv.pMarket ?? null;
  }

  let whaleForGates: Awaited<ReturnType<typeof findWhaleByWallet>> = null;
  if (wallet && isPrismaEnabled()) {
    whaleForGates = await findWhaleByWallet(normalizeWalletAddress(wallet));
  }

  const walletAddress = wallet
    ? normalizeWalletAddress(wallet)
    : "0x0000000000000000000000000000000000000000";
  const nowCents =
    pipelinePmMid != null ? priceToCents(pipelinePmMid) : priceToCents(trade.price);
  const payload = buildTradePayload(trade, walletAddress, nowCents);

  const eligibility = await evaluateTradeEligibility(
    payload,
    whaleForGates,
    Date.now(),
    { tradeEvPercent, metrics }
  );

  if (!eligibility.matrix.passesAll || !eligibility.translation) {
    return;
  }

  if (!isPrismaEnabled()) {
    logEnqueueSkip(trade, "[Skip: Setup] Prisma/DATABASE_URL not configured");
    return;
  }
  if (!wallet) {
    logEnqueueSkip(trade, "[Skip: Setup] Missing proxy wallet");
    return;
  }

  const prisma = getPrisma();
  if (!prisma) {
    logEnqueueSkip(trade, "[Skip: Setup] Prisma client unavailable");
    return;
  }

  const whaleRegistry =
    whaleForGates != null
      ? { whale: whaleForGates, created: false }
      : await ensureWhaleInRegistry(normalizeWalletAddress(wallet), {
          avgStakeNotional: trade.usdNotional,
        });
  if (!whaleRegistry) {
    logEnqueueSkip(trade, "[Skip: Setup] Whale registry upsert failed");
    return;
  }

  const { copyText, family } = generateXPostCopy({
    whale: whaleRegistry.whale.pseudonym,
    side: eligibility.translation.side,
    entry: payload.entryCents,
    now: payload.nowCents,
    avg_ev: whaleRegistry.whale.avgEv,
    marketPlain: eligibility.translation.marketPlain,
    stakeNotional: payload.stakeNotional,
    avgStakeNotional: whaleRegistry.whale.avgStakeNotional,
    postedCount30d: whaleRegistry.whale.postedCount30d,
    resolvedBetsCount: whaleRegistry.whale.resolvedBetsCount,
    winRate: whaleRegistry.whale.winRate,
  });

  let queued: Awaited<ReturnType<typeof prisma.xPostQueue.create>>;
  try {
    queued = await prisma.xPostQueue.create({
      data: {
        id: randomUUID(),
        walletAddress: normalizeWalletAddress(wallet),
        tradeId: payload.tradeId,
        templateFamily: family,
        copyText,
        marketSlug: payload.marketSlug,
        side: eligibility.translation.side,
        entryCents: payload.entryCents,
        nowCents: payload.nowCents,
        stakeNotional: payload.stakeNotional,
        status: "PENDING_REVIEW",
        reviewToken: randomUUID(),
      },
    });
  } catch (error) {
    console.error("[DB WRITE ERROR]", error);
    throw error;
  }

  console.log("[SUCCESS: Queued] Trade added to x_post_queue");
  if (metrics) recordQueuedSuccess(metrics);

  void dispatchAdminReviewAlert(queued as XPostQueue).catch((err) => {
    console.error("[x-agent/enqueue] admin alert failed", {
      tradeId: payload.tradeId,
      error: err instanceof Error ? err.message : err,
    });
  });
}
