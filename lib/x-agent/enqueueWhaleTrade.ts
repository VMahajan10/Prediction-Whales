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
  evaluateDeterministicPreGates,
  evaluateTradeEvPreGate,
  evaluateWalletCredibilityPreGate,
  handlePreGateRejection,
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
} from "@/lib/x-agent/gateMetrics";
import { dispatchAdminReviewAlert } from "@/lib/x-agent/notifications";
import {
  resolveReviewEmailRecipients,
  sendReviewEmail,
} from "@/lib/email/sendReviewEmail";
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
 * High-EV whale ingestion hook: cheap deterministic gates first, then trade EV
 * (OpenAI / p_true pipeline), then enqueue an X post draft when all gates pass.
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
  const nowMs = Date.now();
  const payload = buildTradePayload(
    trade,
    walletAddress,
    priceToCents(trade.price)
  );
  const metricsOptions = { metrics: metricsCollector ?? metrics };

  // Steps 1–3 (+ Polymarket source): freshness → stake → alignment. Short-circuit.
  const preGate = evaluateDeterministicPreGates(payload, nowMs);
  if (!preGate.passed || !preGate.translation) {
    await handlePreGateRejection(payload, preGate, metricsOptions);
    return;
  }
  const translation = preGate.translation;

  // Step 4: wallet credibility (DB / Polymarket RPC — no OpenAI).
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

  const credibilityGate = evaluateWalletCredibilityPreGate(
    payload,
    whaleForGates
  );
  if (!credibilityGate.passed) {
    await handlePreGateRejection(
      payload,
      credibilityGate,
      metricsOptions,
      whaleForGates
    );
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

  // Step 5: dedupe — active x_post_queue row for whale-market pair.
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
    await handlePreGateRejection(
      payload,
      {
        passed: false,
        reason: "RECENT_MARKET_POST",
        failedStep: "dedupe",
      },
      metricsOptions,
      whaleForGates
    );
    return;
  }

  // Step 6: trade EV via p_true / sentiment pipeline (OpenAI — only after steps 1–5).
  const evInput = whaleToEvInput(trade);
  const lookupKey = evInput ? pipelineEvLookupKey(evInput) : null;

  let tradeEvPercent: number | null = null;
  let pipelinePmMid: number | null = null;
  if (evInput && lookupKey) {
    const pipelineEv = await ensureFullyComputedTradeEv(lookupKey, evInput);
    tradeEvPercent = coalesceDisplayEvPercent(pipelineEv);
    pipelinePmMid = pipelineEv.pMarket ?? null;
  }

  const evGate = evaluateTradeEvPreGate(tradeEvPercent);
  if (!evGate.passed) {
    await handlePreGateRejection(
      payload,
      evGate,
      metricsOptions,
      whaleForGates
    );
    return;
  }

  const pricedPayload: TradePayload = {
    ...payload,
    nowCents:
      pipelinePmMid != null ? priceToCents(pipelinePmMid) : payload.nowCents,
  };

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
        side: translation.side,
        entry: pricedPayload.entryCents,
        now: pricedPayload.nowCents,
        avg_ev: whaleRegistry.whale.avgEv,
        marketPlain: translation.marketPlain,
        stakeNotional: pricedPayload.stakeNotional,
        avgStakeNotional: whaleRegistry.whale.avgStakeNotional,
        postedCount30d: whaleRegistry.whale.postedCount30d,
        resolvedBetsCount: whaleRegistry.whale.resolvedBetsCount,
        winRate: whaleRegistry.whale.winRate,
        category: translation.marketPlain,
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
        tradeId: pricedPayload.tradeId,
        templateFamily: family,
        variantId,
        copyText,
        marketSlug: pricedPayload.marketSlug,
        side: translation.side,
        entryCents: pricedPayload.entryCents,
        nowCents: pricedPayload.nowCents,
        stakeNotional: pricedPayload.stakeNotional,
        status: "PENDING_REVIEW",
        reviewToken: randomUUID(),
      },
    });
  } catch (error) {
    console.error("[DB WRITE ERROR]", error);
    throw error;
  }

  console.log(
    `[QUEUED TO X_POST_QUEUE] Trade ID: ${pricedPayload.tradeId} | Whale: ${whaleRegistry.whale.pseudonym} | Template: ${family}/${variantId} | Stake: $${Math.round(pricedPayload.stakeNotional).toLocaleString("en-US")}`
  );
  if (metricsCollector) {
    metricsCollector.recordQueuedSuccess();
  } else if (metrics) {
    recordQueuedSuccess(metrics as GateSummary);
  }

  void dispatchAdminReviewAlert(queued as XPostQueue).catch((err) => {
    console.error("[x-agent/enqueue] admin alert failed", {
      tradeId: pricedPayload.tradeId,
      error: err instanceof Error ? err.message : err,
    });
  });

  // Review email is sent synchronously immediately after x_post_queue insert.
  const notificationEmail =
    process.env.NOTIFICATION_EMAIL?.trim() ||
    process.env.REVIEW_RECIPIENT_EMAILS?.trim() ||
    undefined;
  const resolvedRecipients = resolveReviewEmailRecipients();

  console.log(
    "[Queue] Sending email notification to:",
    notificationEmail ?? resolvedRecipients.join(", ") ?? undefined
  );
  if (!notificationEmail && resolvedRecipients.length === 0) {
    console.error(
      "[Queue] NOTIFICATION_EMAIL and REVIEW_RECIPIENT_EMAILS are undefined — email will be skipped"
    );
  }

  try {
    const res = await sendReviewEmail({
      id: queued.id,
      copyText: queued.copyText,
      renderedDraft: queued.copyText,
      templateFamily: family,
      variantId,
      stakeNotional: queued.stakeNotional,
      evPercent: tradeEvPercent,
      marketTitle: translation.marketPlain,
    });

    if (res.sent) {
      console.log("[Queue] Email sent successfully:", res);
      console.log("✅ Email sent for trade ID:", pricedPayload.tradeId);
    } else {
      console.error("[Queue] Failed to send email:", res.error ?? res);
      console.error(
        "❌ Failed to send email for trade ID:",
        pricedPayload.tradeId,
        res.error ?? "unknown error"
      );
    }
  } catch (err) {
    console.error("[Queue] Failed to send email:", err);
    console.error(
      "❌ Failed to send email for trade ID:",
      pricedPayload.tradeId,
      err
    );
  }
}
