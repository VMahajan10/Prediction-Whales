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
  logGateCheck,
  logSourceSkip,
  type TradePayload,
} from "@/lib/x-agent/gates";
import {
  type GateSummary,
  HIGH_EV_TRADE_THRESHOLD_PCT,
  recordEvThresholdFailure,
  recordKalshiSourceFailure,
  recordQueuedSuccess,
  recordTradeEvaluated,
} from "@/lib/x-agent/gateMetrics";
import { dispatchAdminReviewAlert } from "@/lib/x-agent/notifications";
import { generateXPostCopy } from "@/lib/x-agent/templates";
import {
  ensureWhaleInRegistry,
  normalizeWalletAddress,
} from "@/lib/x-agent/whaleRegistryDb";

export { HIGH_EV_TRADE_THRESHOLD_PCT } from "@/lib/x-agent/gateMetrics";

function formatEvPercent(pct: number): string {
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}

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
 * in WhaleRegistry via Prisma, then enqueue an X post draft when gates pass.
 */
export async function processWhaleTradeForXAgent(
  trade: WhaleTrade,
  metrics?: GateSummary
): Promise<void> {
  if (metrics) {
    recordTradeEvaluated(metrics);
  }

  if (!isPrismaEnabled()) {
    logEnqueueSkip(trade, "[Skip: Setup] Prisma/DATABASE_URL not configured");
    return;
  }
  if (trade.source !== "polymarket") {
    logGateCheck(trade.id);
    if (trade.source === "kalshi") {
      logSourceSkip();
      if (metrics) recordKalshiSourceFailure(metrics);
    } else {
      logEnqueueSkip(
        trade,
        `[Skip: Source] Trade is from ${trade.source} (Polymarket required)`
      );
    }
    return;
  }

  const wallet = trade.proxyWallet?.trim();
  if (!wallet) {
    logEnqueueSkip(trade, "[Skip: Setup] Missing proxy wallet");
    return;
  }

  const prisma = getPrisma();
  if (!prisma) {
    logEnqueueSkip(trade, "[Skip: Setup] Prisma client unavailable");
    return;
  }

  const evInput = whaleToEvInput(trade);
  const lookupKey = evInput ? pipelineEvLookupKey(evInput) : null;
  if (!evInput || !lookupKey) {
    logEnqueueSkip(
      trade,
      "[Skip: Setup] Missing Polymarket asset id for EV lookup"
    );
    return;
  }

  const pipelineEv = await ensureFullyComputedTradeEv(lookupKey, evInput);
  const tradeEvPercent = coalesceDisplayEvPercent(pipelineEv);
  if (tradeEvPercent == null) {
    logEnqueueSkip(trade, "[Skip: Trade EV] Trade EV unavailable");
    if (metrics) recordEvThresholdFailure(metrics);
    return;
  }
  if (tradeEvPercent < HIGH_EV_TRADE_THRESHOLD_PCT) {
    logEnqueueSkip(
      trade,
      `[Skip: Trade EV] Trade EV (${formatEvPercent(tradeEvPercent)}) < ${HIGH_EV_TRADE_THRESHOLD_PCT}% threshold`
    );
    if (metrics) recordEvThresholdFailure(metrics);
    return;
  }
  console.log(
    `[Pass: Trade EV] Trade EV (${formatEvPercent(tradeEvPercent)}) >= ${HIGH_EV_TRADE_THRESHOLD_PCT}% threshold`
  );

  const walletAddress = normalizeWalletAddress(wallet);
  const registry = await ensureWhaleInRegistry(walletAddress, {
    avgEv: tradeEvPercent / 100,
    avgStakeNotional: trade.usdNotional,
  });
  if (!registry) {
    logEnqueueSkip(trade, "[Skip: Setup] Whale registry upsert failed");
    return;
  }

  const nowCents =
    pipelineEv.pMarket != null
      ? priceToCents(pipelineEv.pMarket)
      : priceToCents(trade.price);

  const payload = buildTradePayload(trade, walletAddress, nowCents);
  const eligibility = await evaluateTradeEligibility(
    payload,
    registry.whale,
    Date.now(),
    { skipWhaleStatGates: registry.created, metrics }
  );

  if (!eligibility.eligible || !eligibility.translation) return;

  const { copyText, family } = generateXPostCopy({
    whale: registry.whale.pseudonym,
    side: eligibility.translation.side,
    entry: payload.entryCents,
    now: payload.nowCents,
    avg_ev: registry.whale.avgEv,
    marketPlain: eligibility.translation.marketPlain,
    stakeNotional: payload.stakeNotional,
    avgStakeNotional: registry.whale.avgStakeNotional,
    postedCount30d: registry.whale.postedCount30d,
    resolvedBetsCount: registry.whale.resolvedBetsCount,
    winRate: registry.whale.winRate,
  });

  let queued: Awaited<ReturnType<typeof prisma.xPostQueue.create>>;
  try {
    queued = await prisma.xPostQueue.create({
      data: {
        id: randomUUID(),
        walletAddress,
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
