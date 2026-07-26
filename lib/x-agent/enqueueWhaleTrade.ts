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
  MIN_WALLET_AVG_EV_DECIMAL,
  MIN_WALLET_RESOLVED_BETS,
  type GateSummary,
  type GateMetricsCollector,
  HIGH_EV_TRADE_THRESHOLD_PCT,
  resolveGateMetricsCollector,
  recordQueuedSuccess,
  recordTradeEvaluated,
} from "@/lib/x-agent/gateMetrics";
import { dispatchAdminReviewAlert } from "@/lib/x-agent/notifications";
import { sendReviewEmail } from "@/lib/email/sendReviewEmail";
import { selectPostTemplate } from "@/lib/templates/postTemplates";
import {
  fetchLastTemplateFamily,
  hasActiveWhaleMarketQueueItem,
} from "@/lib/templates/queueHelpers";
import {
  ANONYMOUS_WALLET_ADDRESS,
  ANONYMOUS_WHALE_PSEUDONYM,
  ensureWhaleInRegistry,
  isAnonymousWalletAddress,
  normalizeWalletAddress,
} from "@/lib/x-agent/whaleRegistryDb";
import { resolveWhaleForCredibilityGate } from "@/lib/x-agent/walletCredibility";

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
  metrics?: GateSummary | GateMetricsCollector
): Promise<void> {
  const metricsCollector = resolveGateMetricsCollector(metrics);
  if (metricsCollector) {
    metricsCollector.recordTradeEvaluated();
  }

  const proxyWallet = trade.proxyWallet?.trim();
  const anonymousTrade = isAnonymousWalletAddress(proxyWallet);
  const walletAddress = anonymousTrade
    ? ANONYMOUS_WALLET_ADDRESS
    : normalizeWalletAddress(proxyWallet!);
  const evInput = whaleToEvInput(trade);
  const lookupKey = evInput ? pipelineEvLookupKey(evInput) : null;

  let tradeEvPercent: number | null = null;
  let pipelinePmMid: number | null = null;
  if (evInput && lookupKey) {
    const pipelineEv = await ensureFullyComputedTradeEv(lookupKey, evInput);
    tradeEvPercent = coalesceDisplayEvPercent(pipelineEv);
    pipelinePmMid = pipelineEv.pMarket ?? null;
  }

  let whaleForGates: Awaited<
    ReturnType<typeof resolveWhaleForCredibilityGate>
  >["whale"] = null;
  if (!anonymousTrade && isPrismaEnabled()) {
    const credibility = await resolveWhaleForCredibilityGate(walletAddress);
    whaleForGates = credibility.whale;
    if (credibility.source === "polymarket_api") {
      console.log(
        "[x-agent/enqueue] wallet credibility hydrated from Polymarket Data API",
        {
          wallet: walletAddress,
          resolvedBetsCount: credibility.stats?.resolvedBetsCount,
          avgEv: credibility.stats?.avgEv,
        }
      );
    }
  }

  const nowCents =
    pipelinePmMid != null ? priceToCents(pipelinePmMid) : priceToCents(trade.price);
  const payload = buildTradePayload(trade, walletAddress, nowCents);

  const eligibility = await evaluateTradeEligibility(
    payload,
    whaleForGates,
    Date.now(),
    { tradeEvPercent, metrics: metricsCollector ?? metrics }
  );

  if (!eligibility.matrix.passesAll || !eligibility.translation) {
    return;
  }

  if (!isPrismaEnabled()) {
    logEnqueueSkip(trade, "[Skip: Setup] Prisma/DATABASE_URL not configured");
    return;
  }

  const prisma = getPrisma();
  if (!prisma) {
    logEnqueueSkip(trade, "[Skip: Setup] Prisma client unavailable");
    return;
  }

  const whaleRegistry =
    !anonymousTrade &&
    whaleForGates != null &&
    whaleForGates.resolvedBetsCount >= MIN_WALLET_RESOLVED_BETS &&
    whaleForGates.avgEv >= MIN_WALLET_AVG_EV_DECIMAL
      ? { whale: whaleForGates, created: false }
      : await ensureWhaleInRegistry(walletAddress, {
          pseudonym: anonymousTrade ? ANONYMOUS_WHALE_PSEUDONYM : undefined,
          avgStakeNotional: trade.usdNotional,
        });
  if (!whaleRegistry) {
    logEnqueueSkip(trade, "[Skip: Setup] Whale registry upsert failed");
    return;
  }

  if (anonymousTrade) {
    console.log(
      "[x-agent/enqueue] Unresolved proxy wallet — queuing with anonymous placeholder"
    );
  }

  const duplicateQueue = await hasActiveWhaleMarketQueueItem(
    prisma,
    walletAddress,
    payload.marketSlug
  );
  if (duplicateQueue) {
    logEnqueueSkip(
      trade,
      "[Skip: Dedupe] Active x_post_queue row exists for whale-market pair"
    );
    return;
  }

  let lastTemplateFamily: string | undefined;
  try {
    lastTemplateFamily = await fetchLastTemplateFamily(prisma);
  } catch (error) {
    console.warn("[x-agent/enqueue] failed to load last template family", {
      error: error instanceof Error ? error.message : error,
    });
  }

  let templateSelection: ReturnType<typeof selectPostTemplate>;
  try {
    templateSelection = selectPostTemplate(
      {
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
        category: eligibility.translation.marketPlain,
      },
      { lastTemplateFamily }
    );
  } catch (error) {
    logEnqueueSkip(
      trade,
      `[Skip: Template] ${
        error instanceof Error ? error.message : "template selection failed"
      }`
    );
    return;
  }

  const { renderedDraft: copyText, templateFamily: family, variantId } =
    templateSelection;

  let queued: Awaited<ReturnType<typeof prisma.xPostQueue.create>>;
  try {
    queued = await prisma.xPostQueue.create({
      data: {
        id: randomUUID(),
        walletAddress,
        tradeId: payload.tradeId,
        templateFamily: family,
        variantId,
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

  console.log(
    `[QUEUED TO X_POST_QUEUE] Trade ID: ${payload.tradeId} | Whale: ${whaleRegistry.whale.pseudonym} | Template: ${family}/${variantId} | Stake: $${Math.round(payload.stakeNotional).toLocaleString("en-US")}`
  );
  if (metricsCollector) {
    metricsCollector.recordQueuedSuccess();
  } else if (metrics) {
    recordQueuedSuccess(metrics as GateSummary);
  }

  void dispatchAdminReviewAlert(queued as XPostQueue).catch((err) => {
    console.error("[x-agent/enqueue] admin alert failed", {
      tradeId: payload.tradeId,
      error: err instanceof Error ? err.message : err,
    });
  });

  try {
    const emailResult = await sendReviewEmail({
      id: queued.id,
      copyText: queued.copyText,
      renderedDraft: queued.copyText,
      templateFamily: family,
      variantId,
      stakeNotional: queued.stakeNotional,
      evPercent: tradeEvPercent,
      marketTitle: eligibility.translation.marketPlain,
    });

    if (emailResult.sent) {
      console.log(
        `Successfully queued trade ID ${payload.tradeId} and sent email`
      );
    } else {
      console.error(
        `Failed to send email for trade ID ${payload.tradeId}`,
        emailResult.skipped
          ? { skipped: true, reason: emailResult.error }
          : { error: emailResult.error }
      );
    }
  } catch (error) {
    console.error("Email send failed:", error);
    console.error(`Failed to send email for trade ID ${payload.tradeId}`);
  }
}
