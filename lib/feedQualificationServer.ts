import "server-only";

import { mapWithConcurrency } from "@/lib/clvPriceHistory";
import { fetchProductFeedHistoricalVolumeByWallet } from "@/lib/feed/productFeedHistoricalVolume";
import { evaluateLiveFeedTradeGate } from "@/lib/feedGate";
import { resolveFeedFilterCategoryLabel } from "@/lib/feedFilterDiagnostics";
import type { ResolvedWhaleIdentity } from "@/lib/whaleIdentityResolver";
import {
  isQualifiedWalletForProductFeed,
  passesPolymarketFeedTraderGate,
  meetsProductFeedStakeThreshold,
  meetsFeedTradeEvThreshold,
  resolvePolymarketTradeNotionalUsd,
  resolveProductFeedWalletBlockReason,
  type ProductFeedWalletBlockReason,
  type WalletFeedQualificationInput,
} from "@/lib/feedQualification";
import {
  resolveFeedTradeEvPercents,
} from "@/lib/feedTradeEvServer";
import { schedulePersistProductFeedTradeEligibility } from "@/lib/feed/persistProductFeedTradeEligibility";
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
import { resolveWalletHydrationStatus } from "@/lib/x-agent/walletHydrationState";
import type { WhaleRegistry } from "@/lib/crossmarket/store/schema";
import { enrichTradesWithWhaleAlias } from "@/lib/trades/getTrades";
import { schedulePolicyAShadowForTradeGateQualifiedTrades } from "@/lib/walletLedger/indexed/shadow/policyACoverageShadow";
import {
  historicalVolumeObservabilityFields,
  type ProductFeedHistoricalVolumeResolution,
} from "@/lib/feed/productFeedHistoricalVolume";

export interface WalletFeedQualification extends WalletFeedQualificationInput {
  qualified: boolean;
  /** Authoritative indexed volume used for qualification (never count×avgStake). */
  resolvedVolumeUSD: number | null;
  /** Same as {@link resolvedVolumeUSD} — explicit diagnostic name. */
  historicalVolumeUsd: number | null;
  /** Whether {@link historicalVolumeUsd} is trusted for the product feed gate. */
  historicalVolumeTrusted: boolean;
  /** Volume-specific block reason; null when volume requirement passes. */
  historicalVolumeReason:
    | import("@/lib/feedQualification").ProductFeedHistoricalVolumeGateReason
    | null;
  /** Overall wallet gate block reason; null when {@link qualified}. */
  productFeedWalletBlockReason: ProductFeedWalletBlockReason | null;
  identity: ResolvedWhaleIdentity;
  hydrationState: "pending" | "complete" | "failed";
}

/** Registry lookups are one DB round trip each — cap parallel wallet queries. */
const WALLET_QUALIFICATION_CONCURRENCY = 8;

function registryStats(
  whale: WhaleRegistry | null,
  resolvedVolumeUSD: number | null = null
): WhaleRegistryStats | null {
  if (!whale) return null;
  const avgStakeNotional = whale.avgStakeNotional;
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
  pseudonymOverride?: string | null,
  resolvedVolumeUSD: number | null = null
): ResolvedWhaleIdentity {
  return resolveWhaleIdentity(
    walletAddress,
    pseudonymOverride ?? whale?.pseudonym ?? null,
    registryStats(whale, resolvedVolumeUSD)
  );
}

function buildWalletFeedQualification(
  walletAddress: string,
  whale: WhaleRegistry | null,
  historicalVolume: ProductFeedHistoricalVolumeResolution
): WalletFeedQualification {
  const volumeFields = historicalVolumeObservabilityFields(historicalVolume);
  const authoritativeVolumeForIdentity =
    historicalVolume.historicalResolvedVolumeTrusted
      ? historicalVolume.resolvedVolumeUSD
      : null;

  const identity = resolveRegistryWhaleIdentity(
    walletAddress,
    whale,
    whale?.pseudonym ?? null,
    authoritativeVolumeForIdentity
  );

  if (!whale) {
    const blockReason = resolveProductFeedWalletBlockReason({
      walletInRegistry: false,
      hydrationState: "pending",
      historicalVolumeGateReason: "historical_volume_unavailable",
      historicalResolvedVolumeTrusted: false,
    });
    return {
      qualified: false,
      hydrationState: "pending",
      avgEv: null,
      resolvedBetsCount: null,
      avgStakeNotional: null,
      resolvedVolumeUSD: null,
      historicalResolvedVolumeTrusted: false,
      historicalVolumeGateReason: "historical_volume_unavailable",
      ...volumeFields,
      productFeedWalletBlockReason: blockReason,
      identity,
    };
  }

  const hydrationState = resolveWalletHydrationStatus(whale);

  if (hydrationState !== "complete") {
    const blockReason = resolveProductFeedWalletBlockReason({
      walletInRegistry: true,
      hydrationState,
      resolvedBetsCount: whale.resolvedBetsCount,
      historicalVolumeGateReason: "historical_volume_unavailable",
      historicalResolvedVolumeTrusted: false,
    });
    return {
      qualified: false,
      hydrationState,
      avgEv: null,
      resolvedBetsCount: null,
      avgStakeNotional: null,
      resolvedVolumeUSD: null,
      historicalResolvedVolumeTrusted: false,
      historicalVolumeGateReason: "historical_volume_unavailable",
      ...volumeFields,
      productFeedWalletBlockReason: blockReason,
      identity,
    };
  }

  const stats: WalletFeedQualificationInput = {
    avgEv: whale.avgEv,
    resolvedBetsCount: whale.resolvedBetsCount,
    avgStakeNotional: whale.avgStakeNotional,
    hydrationState,
    resolvedVolumeUSD: historicalVolume.resolvedVolumeUSD,
    historicalResolvedVolumeTrusted:
      historicalVolume.historicalResolvedVolumeTrusted,
    historicalVolumeGateReason: historicalVolume.historicalVolumeGateReason,
  };

  const qualified = isQualifiedWalletForProductFeed(stats);
  const productFeedWalletBlockReason = qualified
    ? null
    : resolveProductFeedWalletBlockReason({
        walletInRegistry: true,
        hydrationState,
        ...stats,
      });

  return {
    qualified,
    hydrationState,
    avgEv: whale.avgEv,
    resolvedBetsCount: whale.resolvedBetsCount,
    avgStakeNotional: whale.avgStakeNotional,
    resolvedVolumeUSD: historicalVolume.resolvedVolumeUSD,
    historicalResolvedVolumeTrusted:
      historicalVolume.historicalResolvedVolumeTrusted,
    historicalVolumeGateReason: historicalVolume.historicalVolumeGateReason,
    ...volumeFields,
    productFeedWalletBlockReason,
    identity,
  };
}

export async function qualifyWalletForFeed(
  walletAddress: string
): Promise<WalletFeedQualification> {
  const wallet = walletAddress.trim().toLowerCase();
  const [whale, volumeByWallet] = await Promise.all([
    findWhaleByWalletCaseInsensitive(wallet),
    fetchProductFeedHistoricalVolumeByWallet([wallet]),
  ]);
  const historicalVolume =
    volumeByWallet.get(wallet) ?? {
      status: "unavailable",
      resolvedVolumeUSD: null,
      historicalVolumeGateReason: "historical_volume_unavailable",
      historicalResolvedVolumeTrusted: false,
    };

  return buildWalletFeedQualification(wallet, whale, historicalVolume);
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

  if (unique.length === 0) {
    return {};
  }

  const volumeByWallet =
    await fetchProductFeedHistoricalVolumeByWallet(unique);

  const entries = await mapWithConcurrency(
    unique,
    WALLET_QUALIFICATION_CONCURRENCY,
    async (wallet) => {
      const whale = await findWhaleByWalletCaseInsensitive(wallet);
      const historicalVolume =
        volumeByWallet.get(wallet) ?? {
          status: "unavailable",
          resolvedVolumeUSD: null,
          historicalVolumeGateReason: "historical_volume_unavailable",
          historicalResolvedVolumeTrusted: false,
        };
      return [
        wallet,
        buildWalletFeedQualification(wallet, whale, historicalVolume),
      ] as const;
    }
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

  const walletQualifications =
    options?.walletQualifications ??
    (await qualifyWalletsForFeed(
      candidates
        .map((trade) => trade.proxyWallet?.trim().toLowerCase())
        .filter((wallet): wallet is string => Boolean(wallet))
    ));

  schedulePolicyAShadowForTradeGateQualifiedTrades(
    candidates,
    walletQualifications,
    { tradesDetected: trades.length }
  );

  schedulePersistProductFeedTradeEligibility({
    trades,
    tradeEvPercents,
    walletQualifications,
  });

  const traderQualified = await filterPolymarketTradesByWalletCredibility(
    candidates,
    walletQualifications
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

  const walletQualifications = await qualifyWalletsForFeed(
    qualified
      .map((trade) => trade.proxyWallet?.trim().toLowerCase())
      .filter((wallet): wallet is string => Boolean(wallet))
  );

  schedulePolicyAShadowForTradeGateQualifiedTrades(
    qualified,
    walletQualifications,
    { tradesDetected: trades.length }
  );

  schedulePersistProductFeedTradeEligibility({
    trades,
    tradeEvPercents,
    walletQualifications,
  });

  const traderQualified = await filterPolymarketTradesByWalletCredibility(
    qualified,
    walletQualifications
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
