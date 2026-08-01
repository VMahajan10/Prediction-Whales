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
import { persistKalshiShadowTradeFromWhale } from "@/lib/x-agent/kalshiShadowTrades";
import {
  evaluatePostQueueSourceGate,
  KALSHI_PUBLIC_POSTING_DISABLED,
} from "@/lib/x-agent/postQueueGates";
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
  sendEmailNotification,
  getEffectiveNotificationEmailForLog,
} from "@/lib/email/sendReviewEmail";
import {
  isTelegramConfigured,
  sendTradeTelegramAlert,
} from "@/lib/notifications/telegram";
import { logStderr, logStdout } from "@/lib/utils";
import { selectPostTemplate } from "@/lib/templates/postTemplates";
import {
  fetchLastTemplateFamily,
  hasActiveWhaleMarketQueueItem,
} from "@/lib/templates/queueHelpers";
import { generateMarketContextSummary } from "@/lib/x-agent/marketContextSummary";
import {
  fetchLastEvGloss,
  persistLastEvGloss,
} from "@/lib/x-agent/evGlossStore";
import { formatWhaleDisplayLabel } from "@/lib/x-agent/whaleDisplay";
import {
  ANONYMOUS_WALLET_ADDRESS,
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
  if (trade.source === "kalshi") {
    if (KALSHI_PUBLIC_POSTING_DISABLED) {
      persistKalshiShadowTradeFromWhale(trade);
    }
    return;
  }

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

  // Step 0: Polymarket-only public posting gate.
  const sourceGate = evaluatePostQueueSourceGate({
    source: trade.source,
    tradeId: trade.id,
  });
  if (!sourceGate.passed) {
    await handlePreGateRejection(
      payload,
      {
        passed: false,
        reason: sourceGate.reason,
        failedStep: "source",
      },
      metricsOptions
    );
    return;
  }

  // Steps 1–3: freshness → stake → alignment. Short-circuit.
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
  console.log(
    `[Gate] tradeId=${payload.tradeId} [Pass: Dedupe] No active x_post_queue row for whale-market pair`
  );

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

  const evGate = evaluateTradeEvPreGate(tradeEvPercent, payload.tradeId);
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
    whaleForGates != null &&
    whaleForGates.resolvedBetsCount >= MIN_WALLET_RESOLVED_BETS &&
    whaleForGates.avgEv >= MIN_WALLET_AVG_EV_DECIMAL
      ? { whale: whaleForGates, created: false }
      : await ensureWhaleInRegistry(walletAddress, {
          avgStakeNotional: trade.usdNotional,
        });
  if (!whaleRegistry) {
    logEnqueueSkip(trade, "[Skip: Setup] Whale registry upsert failed");
    return;
  }

  const whaleLabel = formatWhaleDisplayLabel(
    walletAddress,
    whaleRegistry.whale.pseudonym
  );

  let marketContext: string | null = null;
  try {
    marketContext = await generateMarketContextSummary({
      title: trade.title,
      marketPlain: translation.marketPlain,
      side: translation.side,
      slug: trade.slug ?? trade.eventSlug,
    });
  } catch (error) {
    console.warn("[x-agent/enqueue] market context summary failed", {
      tradeId: payload.tradeId,
      error: error instanceof Error ? error.message : error,
    });
  }

  let lastTemplateFamily: string | undefined;
  let lastEvGloss: string | null = null;
  try {
    lastTemplateFamily = await fetchLastTemplateFamily(prisma);
    lastEvGloss = await fetchLastEvGloss(prisma);
  } catch (error) {
    console.warn("[x-agent/enqueue] failed to load template rotation state", {
      error: error instanceof Error ? error.message : error,
    });
  }

  let templateSelection: ReturnType<typeof selectPostTemplate>;
  try {
    templateSelection = selectPostTemplate(
      {
        whale: whaleLabel,
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
        context: marketContext ?? undefined,
      },
      { lastTemplateFamily, lastEvGloss }
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

  const {
    renderedDraft: copyText,
    templateFamily: family,
    variantId,
    evGloss,
  } = templateSelection;

  let queued: Awaited<ReturnType<typeof prisma.xPostQueue.create>>;
  try {
    queued = await prisma.xPostQueue.create({
      data: {
        id: randomUUID(),
        walletAddress,
        tradeId: pricedPayload.tradeId,
        templateFamily: family,
        variantId,
        evGloss,
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
    logStderr("[DB WRITE ERROR]", error);
    throw error;
  }

  const insertedRecord = queued;

  try {
    await persistLastEvGloss(evGloss);
  } catch (error) {
    console.warn("[x-agent/enqueue] failed to persist last EV gloss", {
      tradeId: payload.tradeId,
      error: error instanceof Error ? error.message : error,
    });
  }

  console.log(
    `[Gate] tradeId=${payload.tradeId} [Pass: Queue] Trade entered x_post_queue with status PENDING_REVIEW (id=${insertedRecord.id})`
  );
  logStdout("📌 [Queue Insert] Record created ID:", insertedRecord.id);

  try {
    logStdout(
      "📩 [Queue Email] Dispatching email to:",
      getEffectiveNotificationEmailForLog()
    );
    const emailRes = await sendEmailNotification({
      id: insertedRecord.id,
      copyText: insertedRecord.copyText,
      renderedDraft: insertedRecord.copyText,
      templateFamily: family,
      variantId,
      stakeNotional: insertedRecord.stakeNotional,
      evPercent: tradeEvPercent,
      marketTitle: translation.marketPlain,
      queuedAt: insertedRecord.createdAt,
    });
    if (emailRes.sent) {
      logStdout("✅ [Queue Email Success] Result:", emailRes);
    } else {
      logStderr(
        "❌ [Queue Email Error] Failed for ID:",
        insertedRecord.id,
        emailRes
      );
    }
  } catch (emailErr) {
    logStderr(
      "❌ [Queue Email Error] Failed for ID:",
      insertedRecord.id,
      emailErr
    );
  }

  if (isTelegramConfigured()) {
    try {
      logStdout("📲 [Queue Telegram] Dispatching trade alert");
      const telegramRes = await sendTradeTelegramAlert({
        whaleName: whaleLabel,
        stakeNotional: insertedRecord.stakeNotional,
        marketTitle: translation.marketPlain,
        evPercent: tradeEvPercent,
        queueId: insertedRecord.id,
      });
      if (telegramRes.sent) {
        logStdout("✅ [Queue Telegram Success]");
      } else if (!telegramRes.skipped) {
        logStderr(
          "❌ [Queue Telegram Error] Failed for ID:",
          insertedRecord.id,
          telegramRes.error ?? telegramRes
        );
      }
    } catch (telegramErr) {
      logStderr(
        "❌ [Queue Telegram Error] Failed for ID:",
        insertedRecord.id,
        telegramErr
      );
    }
  }

  logStdout(
    `[QUEUED TO X_POST_QUEUE] Trade ID: ${pricedPayload.tradeId} | Whale: ${whaleLabel} | Template: ${family}/${variantId} | Stake: $${Math.round(pricedPayload.stakeNotional).toLocaleString("en-US")}`
  );
  if (metricsCollector) {
    metricsCollector.recordQueuedSuccess();
  } else if (metrics) {
    recordQueuedSuccess(metrics as GateSummary);
  }

  void dispatchAdminReviewAlert(insertedRecord as XPostQueue).catch((err) => {
    logStderr("[x-agent/enqueue] admin alert failed", {
      tradeId: pricedPayload.tradeId,
      error: err instanceof Error ? err.message : err,
    });
  });
}
