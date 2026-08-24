import { passesLiveFeedTradeGate } from "@/lib/feedGate";
import {
  meetsProductFeedEvThreshold,
  meetsProductFeedStakeThreshold,
  passesPolymarketFeedTraderGate,
} from "@/lib/feedQualification";
import { resolveFeedFilterCategoryLabel } from "@/lib/feedFilterDiagnostics";
import { isKalshiTradeVisibleInUserFeed } from "@/lib/feed/kalshiFeedTrades";
import { resolveFeedTradeEvPercent } from "@/lib/feedTradeEv";
import { translateWhaleTradeMarket } from "@/lib/marketTranslator";
import {
  pipelineEvKeyForWhale,
  resolvePipelineEvForWhale,
} from "@/lib/pipelineEvClient";
import { whaleHasStampedFeedEv } from "@/lib/whaleCardEv";
import type { PipelineTradeEv } from "@/lib/evPipeline/types";
import type { WalletQualification } from "@/lib/useQualifiedWalletFilter";
import type { WhaleTrade } from "@/lib/whaleTrades";

export type WalletQualificationMap = ReadonlyMap<string, WalletQualification>;

export type PolymarketWalletQualificationState = "pending" | "pass" | "fail";

/** Wallet qualification resolution for client feed admission — unknown wallets stay pending. */
export function resolvePolymarketWalletQualificationState(
  wallet: string | undefined,
  walletQualifications: WalletQualificationMap
): PolymarketWalletQualificationState {
  const normalized = wallet?.trim().toLowerCase();
  if (!normalized) return "fail";
  if (!walletQualifications.has(normalized)) return "pending";

  const qualification = walletQualifications.get(normalized);
  return passesPolymarketFeedTraderGate(normalized, qualification)
    ? "pass"
    : "fail";
}

/** Trade-level stake + EV gate for Polymarket feed rows (not wallet credibility). */
export function isPolymarketTradeQualifiedForFeed(
  trade: WhaleTrade,
  pipelineEvIndex: Map<string, PipelineTradeEv>,
  loggedRejects?: Set<string>
): boolean {
  if (trade.source !== "polymarket") return false;

  const pipelineKey = pipelineEvKeyForWhale(trade);
  const pipeline = pipelineKey
    ? resolvePipelineEvForWhale(pipelineEvIndex, trade)
    : undefined;
  const tradeEvPercent = resolveFeedTradeEvPercent(
    {
      price: trade.price,
      netEvPercent: trade.netEvPercent,
      grossEvPercent: trade.grossEvPercent,
    },
    pipeline
  );

  const category = resolveFeedFilterCategoryLabel(trade);
  const feedTrade = {
    stakeUsd: trade.usdNotional,
    title: trade.title,
    slug: trade.slug,
    eventSlug: trade.eventSlug,
    category,
    tradeEvPercent,
  };

  const qualified = passesLiveFeedTradeGate(feedTrade, {
    id: trade.id,
    source: "client",
    logRejection: !loggedRejects?.has(`${trade.id}:${tradeEvPercent ?? "na"}`),
  });
  if (!qualified) {
    const logKey = `${trade.id}:${tradeEvPercent ?? "na"}`;
    loggedRejects?.add(logKey);
  }

  return qualified;
}

/** Wallet credibility gate — only passes once qualification is known and meets thresholds. */
export function passesPolymarketWalletCredibilityForClient(
  wallet: string | undefined,
  qualification: WalletQualification | undefined,
  walletQualifications?: WalletQualificationMap
): boolean {
  if (walletQualifications) {
    return (
      resolvePolymarketWalletQualificationState(wallet, walletQualifications) ===
      "pass"
    );
  }

  const normalized = wallet?.trim().toLowerCase();
  if (!normalized || !qualification) return false;
  return passesPolymarketFeedTraderGate(normalized, qualification);
}

export function isPolymarketTradeEligibleForFeed(
  trade: WhaleTrade,
  pipelineEvIndex: Map<string, PipelineTradeEv>,
  loggedRejects?: Set<string>
): boolean {
  if (
    !isPolymarketTradeQualifiedForFeed(trade, pipelineEvIndex, loggedRejects)
  ) {
    return false;
  }
  return translateWhaleTradeMarket(trade) != null;
}

export function isRenderableFeedWhale(trade: WhaleTrade): boolean {
  return (
    whaleHasStampedFeedEv(trade) &&
    meetsProductFeedEvThreshold(trade.netEvPercent)
  );
}

/**
 * Defense-in-depth visibility gate for Polymarket rows already in whaleBuffer.
 * Requires trade-level admission, translatable market copy, stamped trade EV,
 * and wallet registry credibility. Missing wallet qualification → hidden.
 */
export function passesPolymarketClientFeedVisibilityGate(
  trade: WhaleTrade,
  walletQualifications: WalletQualificationMap,
  pipelineEvIndex: Map<string, PipelineTradeEv>,
  loggedRejects?: Set<string>
): boolean {
  if (trade.source !== "polymarket") return false;
  if (!isRenderableFeedWhale(trade)) return false;
  if (
    !isPolymarketTradeEligibleForFeed(trade, pipelineEvIndex, loggedRejects)
  ) {
    return false;
  }

  const wallet = trade.proxyWallet?.trim().toLowerCase();
  return passesPolymarketWalletCredibilityForClient(
    wallet,
    wallet ? walletQualifications.get(wallet) : undefined,
    walletQualifications
  );
}

/** Final feed visibility — Polymarket uses full gate; Kalshi uses EV + named selection. */
export function isVisibleInClientFeed(
  trade: WhaleTrade,
  walletQualifications: WalletQualificationMap,
  pipelineEvIndex: Map<string, PipelineTradeEv>,
  loggedRejects?: Set<string>
): boolean {
  if (trade.source === "kalshi") {
    return isKalshiTradeVisibleInUserFeed(trade, pipelineEvIndex, {
      id: trade.id,
      logRejection: false,
    });
  }
  return passesPolymarketClientFeedVisibilityGate(
    trade,
    walletQualifications,
    pipelineEvIndex,
    loggedRejects
  );
}

/**
 * Complete Polymarket feed admission gate — trade eligibility plus wallet
 * credibility. Used by buffer admission, metrics, and visibility (with stamp).
 */
export function passesPolymarketClientFeedAdmissionGate(
  trade: WhaleTrade,
  walletQualifications: WalletQualificationMap,
  pipelineEvIndex: Map<string, PipelineTradeEv>,
  loggedRejects?: Set<string>
): boolean {
  if (trade.source !== "polymarket") return false;
  if (
    !isPolymarketTradeEligibleForFeed(trade, pipelineEvIndex, loggedRejects)
  ) {
    return false;
  }

  const wallet = trade.proxyWallet?.trim().toLowerCase();
  return passesPolymarketWalletCredibilityForClient(
    wallet,
    wallet ? walletQualifications.get(wallet) : undefined,
    walletQualifications
  );
}

export function polymarketTradeMetricsKey(trade: WhaleTrade): string {
  return trade.transactionHash || trade.id;
}

export interface PolymarketFeedMetricsAccumulator {
  metricsDetected: Set<string>;
  metricsPassed: Set<string>;
  metricsFinalized: Set<string>;
}

export interface PolymarketFeedMetricsDelta {
  tradesDetected: number;
  gatePassedTrades: number;
  passedWallets: string[];
}

/**
 * Increment client feed metrics for live Polymarket trades.
 * `tradesDetected` counts stake-qualified candidates once; `gatePassedTrades`
 * counts only trades that pass the complete admission gate.
 */
export function aggregatePolymarketFeedMetrics(
  trades: WhaleTrade[],
  walletQualifications: WalletQualificationMap,
  pipelineEvIndex: Map<string, PipelineTradeEv>,
  accumulator: PolymarketFeedMetricsAccumulator,
  loggedRejects?: Set<string>
): PolymarketFeedMetricsDelta {
  let tradesDetected = 0;
  let gatePassedTrades = 0;
  const passedWallets: string[] = [];

  for (const trade of trades) {
    if (trade.source !== "polymarket") continue;

    const key = polymarketTradeMetricsKey(trade);
    if (!key || accumulator.metricsFinalized.has(key)) continue;

    const pipelineKey = pipelineEvKeyForWhale(trade);
    const pipeline = pipelineKey
      ? resolvePipelineEvForWhale(pipelineEvIndex, trade)
      : undefined;
    const tradeEvPercent = resolveFeedTradeEvPercent(
      {
        price: trade.price,
        netEvPercent: trade.netEvPercent,
        grossEvPercent: trade.grossEvPercent,
      },
      pipeline
    );

    if (!meetsProductFeedStakeThreshold(trade.usdNotional)) {
      accumulator.metricsFinalized.add(key);
      continue;
    }

    if (!accumulator.metricsDetected.has(key)) {
      accumulator.metricsDetected.add(key);
      tradesDetected += 1;
    }

    const tradePasses = isPolymarketTradeQualifiedForFeed(
      trade,
      pipelineEvIndex,
      loggedRejects
    );
    const wallet = trade.proxyWallet?.trim().toLowerCase();
    const walletQualification = wallet
      ? walletQualifications.get(wallet)
      : undefined;
    const walletQualificationKnown = Boolean(wallet && walletQualifications.has(wallet));
    const fullyQualified = passesPolymarketClientFeedAdmissionGate(
      trade,
      walletQualifications,
      pipelineEvIndex,
      loggedRejects
    );

    if (fullyQualified) {
      if (!accumulator.metricsPassed.has(key)) {
        accumulator.metricsPassed.add(key);
        gatePassedTrades += 1;
        if (wallet) passedWallets.push(wallet);
      }
      accumulator.metricsFinalized.add(key);
      continue;
    }

    if (!tradePasses && tradeEvPercent != null && Number.isFinite(tradeEvPercent)) {
      accumulator.metricsFinalized.add(key);
      continue;
    }

    if (
      tradePasses &&
      walletQualificationKnown &&
      !passesPolymarketWalletCredibilityForClient(wallet, walletQualification)
    ) {
      accumulator.metricsFinalized.add(key);
    }
  }

  return { tradesDetected, gatePassedTrades, passedWallets };
}

export function collectPolymarketWalletAddresses(
  ...tradeGroups: WhaleTrade[][]
): string[] {
  const wallets = new Set<string>();
  for (const trades of tradeGroups) {
    for (const trade of trades) {
      if (trade.source !== "polymarket") continue;
      const wallet = trade.proxyWallet?.trim().toLowerCase();
      if (wallet) wallets.add(wallet);
    }
  }
  return Array.from(wallets);
}
