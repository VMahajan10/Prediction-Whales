import "server-only";

import { mapWithConcurrency } from "@/lib/clvPriceHistory";
import { evaluateLiveFeedTradeGate } from "@/lib/feedGate";
import { resolveFeedFilterCategoryLabel } from "@/lib/feedFilterDiagnostics";
import type { ResolvedWhaleIdentity } from "@/lib/whaleIdentityResolver";
import {
  isQualifiedWalletForProductFeed,
  passesPolymarketFeedTraderGate,
  meetsProductFeedStakeThreshold,
  meetsFeedTradeEvThreshold,
  resolvePolymarketTradeNotionalUsd,
  resolveTraderResolvedVolumeUsd,
  type WalletFeedQualificationInput,
} from "@/lib/feedQualification";
import {
  resolveFeedTradeEvPercents,
} from "@/lib/feedTradeEvServer";
import { recordFeedMetrics } from "@/lib/feedMetrics";
import {
  translateWhaleTradeMarket,
  type MarketPositionTranslation,
} from "@/lib/marketTranslator";
import {
  resolveWhaleIdentity,
  type WhaleRegistryStats,
} from "@/lib/whaleIdentityResolver";
import { findWhaleByWalletCaseInsensitive } from "@/lib/x-agent/whaleRegistryDb";
import type { WhaleRegistry } from "@/lib/crossmarket/store/schema";
import { enrichTradesWithWhaleAlias } from "@/lib/trades/getTrades";

export interface WalletFeedQualification extends WalletFeedQualificationInput {
  qualified: boolean;
  resolvedVolumeUSD: number | null;
  identity: ResolvedWhaleIdentity;
}

/** Registry lookups are one DB round trip each — cap parallel wallet queries. */
const WALLET_QUALIFICATION_CONCURRENCY = 8;

function registryStats(whale: WhaleRegistry | null): WhaleRegistryStats | null {
  if (!whale) return null;
  const avgStakeNotional = whale.avgStakeNotional;
  const resolvedVolumeUSD = resolveTraderResolvedVolumeUsd({
    resolvedBetsCount: whale.resolvedBetsCount,
    avgStakeNotional,
  });
  return {
    winRate: whale.winRate,
    resolvedBetsCount: whale.resolvedBetsCount,
    avgEv: whale.avgEv,
    avgStakeNotional,
    resolvedVolumeUSD,
  };
}

export function resolveRegistryWhaleIdentity(
  walletAddress: string,
  whale: WhaleRegistry | null,
  pseudonymOverride?: string | null
): ResolvedWhaleIdentity {
  return resolveWhaleIdentity(
    walletAddress,
    pseudonymOverride ?? whale?.pseudonym ?? null,
    registryStats(whale)
  );
}

export async function qualifyWalletForFeed(
  walletAddress: string
): Promise<WalletFeedQualification> {
  const whale = await findWhaleByWalletCaseInsensitive(walletAddress);
  const identity = resolveRegistryWhaleIdentity(
    walletAddress,
    whale,
    whale?.pseudonym ?? null
  );

  if (!whale) {
    return {
      qualified: false,
      avgEv: null,
      resolvedBetsCount: null,
      avgStakeNotional: null,
      resolvedVolumeUSD: null,
      identity,
    };
  }

  const stats = {
    avgEv: whale.avgEv,
    resolvedBetsCount: whale.resolvedBetsCount,
    avgStakeNotional: whale.avgStakeNotional,
  };
  const resolvedVolumeUSD = resolveTraderResolvedVolumeUsd(stats);

  return {
    qualified: isQualifiedWalletForProductFeed(stats),
    avgEv: whale.avgEv,
    resolvedBetsCount: whale.resolvedBetsCount,
    avgStakeNotional: whale.avgStakeNotional,
    resolvedVolumeUSD,
    identity,
  };
}

export async function qualifyWalletsForFeed(
  walletAddresses: string[]
): Promise<Record<string, WalletFeedQualification>> {
  const unique = Array.from(
    new Set(
      walletAddresses
        .map((wallet) => wallet.trim().toLowerCase())
        .filter((wallet) => wallet.length > 0)
    )
  );

  const entries = await mapWithConcurrency(
    unique,
    WALLET_QUALIFICATION_CONCURRENCY,
    async (wallet) => [wallet, await qualifyWalletForFeed(wallet)] as const
  );

  return Object.fromEntries(entries);
}

/** Shared Polymarket wallet gate for live feed, recent/backfill, and history writes. */
export async function filterPolymarketTradesByWalletCredibility<
  T extends { proxyWallet?: string | null },
>(
  trades: T[],
  existingQualifications?: Record<string, WalletFeedQualification>
): Promise<T[]> {
  const wallets = trades
    .map((trade) => trade.proxyWallet?.trim().toLowerCase())
    .filter((wallet): wallet is string => Boolean(wallet));

  const qualifications =
    existingQualifications ??
    (wallets.length > 0 ? await qualifyWalletsForFeed(wallets) : {});

  return trades.filter((trade) => {
    const wallet = trade.proxyWallet?.trim().toLowerCase();
    const qualification = wallet ? qualifications[wallet] : undefined;
    return passesPolymarketFeedTraderGate(wallet, qualification);
  });
}

export async function traderMeetsProductFeedCredibility(
  walletAddress: string | null | undefined
): Promise<boolean> {
  const wallet = walletAddress?.trim();
  if (!wallet) return false;
  const qualification = await qualifyWalletForFeed(wallet);
  return passesPolymarketFeedTraderGate(wallet, qualification);
}

export interface PolymarketFeedTradeLike {
  id: string;
  size: number;
  price: number;
  proxyWallet?: string | null;
  title: string;
  outcome: string;
  side?: "BUY" | "SELL";
  slug?: string | null;
  eventSlug?: string | null;
  endDate?: string | null;
  outcomes?: readonly string[] | null;
  assetId?: string | null;
}

export function filterTranslatablePolymarketFeedTrades<
  T extends PolymarketFeedTradeLike,
>(trades: T[]): Array<T & { marketTranslation: MarketPositionTranslation }> {
  const translatable: Array<T & { marketTranslation: MarketPositionTranslation }> =
    [];

  for (const trade of trades) {
    const marketTranslation = translateWhaleTradeMarket(trade);
    if (!marketTranslation) continue;
    translatable.push({ ...trade, marketTranslation });
  }

  return translatable;
}

export type QualifiedPolymarketFeedTrade<T extends PolymarketFeedTradeLike> =
  T & {
    /** Trade-level EV % at entry (same units as MIN_FEED_TRADE_EV_PCT). */
    netEvPercent: number;
    averageEv: number;
  };

export type PolymarketFeedCandidateTrade<T extends PolymarketFeedTradeLike> =
  T & {
    /** Cached trade EV % — null until the pipeline has computed this asset. */
    netEvPercent: number | null;
    averageEv: number | null;
  };

/**
 * Page-load feed candidates: stake floor + trade EV >= +3.0%.
 * Hydrates pipeline EV on cache miss so cold assets are not dropped at ingest.
 */
export async function collectPolymarketFeedCandidates<
  T extends PolymarketFeedTradeLike,
>(
  trades: T[],
  options?: {
    walletQualifications?: Record<string, WalletFeedQualification>;
  }
): Promise<Array<QualifiedPolymarketFeedTrade<T>>> {
  const tradeEvPercents = await resolveFeedTradeEvPercents(
    trades.map((trade) => ({
      id: trade.id,
      price: trade.price,
      assetId: trade.assetId,
    }))
  );

  const candidates: Array<QualifiedPolymarketFeedTrade<T>> = [];

  for (const trade of trades) {
    const notionalUsd = resolvePolymarketTradeNotionalUsd(trade);
    const category = resolveFeedFilterCategoryLabel(trade);
    const tradeEvPercent = tradeEvPercents.get(trade.id) ?? null;

    if (
      !evaluateLiveFeedTradeGate(
        {
          stakeUsd: notionalUsd,
          title: trade.title,
          slug: trade.slug,
          eventSlug: trade.eventSlug,
          category,
          tradeEvPercent,
        },
        { id: trade.id, source: "api" }
      ).passed
    ) {
      continue;
    }

    if (tradeEvPercent == null || !Number.isFinite(tradeEvPercent)) {
      continue;
    }

    candidates.push({
      ...trade,
      netEvPercent: tradeEvPercent,
      averageEv: tradeEvPercent,
    });
  }

  const traderQualified = await filterPolymarketTradesByWalletCredibility(
    candidates,
    options?.walletQualifications
  );

  recordFeedMetrics({
    venue: "polymarket",
    tradesDetected: trades.length,
    gatePassedTrades: traderQualified.length,
    whaleWallets: traderQualified
      .map((trade) => trade.proxyWallet)
      .filter((wallet): wallet is string => Boolean(wallet)),
  });

  return traderQualified;
}

export async function filterQualifiedPolymarketFeedTrades<
  T extends PolymarketFeedTradeLike,
>(trades: T[]): Promise<Array<QualifiedPolymarketFeedTrade<T>>> {
  const tradeEvPercents = await resolveFeedTradeEvPercents(
    trades.map((trade) => ({
      id: trade.id,
      price: trade.price,
      assetId: trade.assetId,
    }))
  );

  const qualified: Array<QualifiedPolymarketFeedTrade<T>> = [];

  for (const trade of trades) {
    const notionalUsd = resolvePolymarketTradeNotionalUsd(trade);
    const tradeEvPercent = tradeEvPercents.get(trade.id) ?? null;
    const category = resolveFeedFilterCategoryLabel(trade);
    const feedTrade = {
      stakeUsd: notionalUsd,
      title: trade.title,
      slug: trade.slug,
      eventSlug: trade.eventSlug,
      category,
      tradeEvPercent,
    };

    if (
      !evaluateLiveFeedTradeGate(feedTrade, {
        id: trade.id,
        source: "api",
      }).passed
    ) {
      continue;
    }

    if (tradeEvPercent == null || !Number.isFinite(tradeEvPercent)) {
      continue;
    }

    qualified.push({
      ...trade,
      netEvPercent: tradeEvPercent,
      averageEv: tradeEvPercent,
    });
  }

  const traderQualified = await filterPolymarketTradesByWalletCredibility(
    qualified
  );

  recordFeedMetrics({
    venue: "polymarket",
    tradesDetected: trades.length,
    gatePassedTrades: traderQualified.length,
    whaleWallets: traderQualified
      .map((trade) => trade.proxyWallet)
      .filter((wallet): wallet is string => Boolean(wallet)),
  });

  return traderQualified;
}

export async function enrichPolymarketFeedTradesWithIdentity<
  T extends PolymarketFeedTradeLike,
>(
  trades: Array<T & { marketTranslation?: MarketPositionTranslation }>,
  options?: {
    walletQualifications?: Record<string, WalletFeedQualification>;
  }
): Promise<
  Array<
    T & {
      whaleIdentity: ResolvedWhaleIdentity;
      marketTranslation: MarketPositionTranslation;
      whaleAlias: string;
    }
  >
> {
  const wallets = trades
    .map((trade) => trade.proxyWallet?.trim().toLowerCase())
    .filter((wallet): wallet is string => Boolean(wallet));

  const qualifications =
    options?.walletQualifications ??
    (wallets.length > 0 ? await qualifyWalletsForFeed(wallets) : {});

  const enriched = trades.flatMap((trade) => {
    const marketTranslation = translateWhaleTradeMarket(trade);
    if (!marketTranslation) return [];

    const wallet = trade.proxyWallet?.trim().toLowerCase();
    const qualification = wallet ? qualifications[wallet] : undefined;
    if (!passesPolymarketFeedTraderGate(wallet, qualification)) {
      return [];
    }

    const identity =
      qualification?.identity ??
      resolveRegistryWhaleIdentity(wallet ?? "", null, null);
    return [
      {
        ...trade,
        whaleIdentity: identity,
        marketTranslation,
      },
    ];
  });

  return enrichTradesWithWhaleAlias(enriched);
}

export function recordKalshiFeedMetrics(detectedCount: number): void {
  recordFeedMetrics({
    venue: "kalshi",
    tradesDetected: detectedCount,
    gatePassedTrades: 0,
  });
}
