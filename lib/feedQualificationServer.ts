import "server-only";

import {
  isQualifiedFeedTrade,
  isQualifiedWalletForFeed,
  meetsFeedTieredStakeThreshold,
  CREDIBILITY_CONFIG,
  type WalletFeedQualificationInput,
} from "@/lib/feedQualification";
import { resolveFeedTradeEvPercents } from "@/lib/feedTradeEvServer";
import { recordFeedMetrics } from "@/lib/feedMetrics";
import {
  translateWhaleTradeMarket,
  type MarketPositionTranslation,
} from "@/lib/marketTranslator";
import {
  resolveWhaleIdentity,
  type ResolvedWhaleIdentity,
  type WhaleRegistryStats,
} from "@/lib/whaleIdentityResolver";
import { findWhaleByWalletCaseInsensitive } from "@/lib/x-agent/whaleRegistryDb";
import type { WhaleRegistry } from "@/lib/crossmarket/store/schema";

export interface WalletFeedQualification extends WalletFeedQualificationInput {
  qualified: boolean;
  identity: ResolvedWhaleIdentity;
}

function registryStats(whale: WhaleRegistry | null): WhaleRegistryStats | null {
  if (!whale) return null;
  return {
    winRate: whale.winRate,
    resolvedBetsCount: whale.resolvedBetsCount,
    avgEv: whale.avgEv,
  };
}

export function resolveRegistryWhaleIdentity(
  walletAddress: string,
  whale: WhaleRegistry | null
): ResolvedWhaleIdentity {
  return resolveWhaleIdentity(
    walletAddress,
    whale?.pseudonym ?? null,
    registryStats(whale)
  );
}

export async function qualifyWalletForFeed(
  walletAddress: string
): Promise<WalletFeedQualification> {
  const whale = await findWhaleByWalletCaseInsensitive(walletAddress);
  const identity = resolveRegistryWhaleIdentity(walletAddress, whale);

  if (!whale) {
    return {
      qualified: false,
      avgEv: null,
      resolvedBetsCount: null,
      identity,
    };
  }

  const stats = {
    avgEv: whale.avgEv,
    resolvedBetsCount: whale.resolvedBetsCount,
  };

  return {
    qualified: isQualifiedWalletForFeed(stats),
    ...stats,
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

  const entries = await Promise.all(
    unique.map(
      async (wallet) => [wallet, await qualifyWalletForFeed(wallet)] as const
    )
  );

  return Object.fromEntries(entries);
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

export async function filterQualifiedPolymarketFeedTrades<
  T extends PolymarketFeedTradeLike,
>(trades: T[]): Promise<T[]> {
  const stakeCandidates = trades.filter((trade) =>
    meetsFeedTieredStakeThreshold({
      stakeUsd: trade.size,
      title: trade.title,
      slug: trade.slug,
      eventSlug: trade.eventSlug,
    })
  );

  const wallets = stakeCandidates
    .map((trade) => trade.proxyWallet?.trim().toLowerCase())
    .filter((wallet): wallet is string => Boolean(wallet));

  const qualifications = await qualifyWalletsForFeed(wallets);

  const credibilityCandidates = stakeCandidates.filter((trade) => {
    const wallet = trade.proxyWallet?.trim().toLowerCase();
    if (!wallet) return false;
    const walletStats = qualifications[wallet];
    const resolvedBetCount = walletStats?.resolvedBetsCount ?? null;

    return isQualifiedWalletForFeed({
      avgEv: walletStats?.avgEv,
      resolvedBetCount,
    });
  });

  const tradeEvPercents = await resolveFeedTradeEvPercents(
    credibilityCandidates.map((trade) => ({
      id: trade.id,
      price: trade.price,
      assetId: trade.assetId,
    }))
  );

  const qualified = credibilityCandidates.filter((trade) => {
    const wallet = trade.proxyWallet?.trim().toLowerCase();
    if (!wallet) return false;
    const walletStats = qualifications[wallet];
    const resolvedBetCount = walletStats?.resolvedBetsCount ?? null;
    const tradeEvPercent = tradeEvPercents.get(trade.id) ?? null;
    const feedTrade = {
      stakeUsd: trade.size,
      walletAvgEv: walletStats?.avgEv,
      resolvedBetCount,
      title: trade.title,
      slug: trade.slug,
      eventSlug: trade.eventSlug,
      tradeEvPercent,
    };

    if (!isQualifiedFeedTrade(feedTrade)) {
      console.log(
        `[api/feed] trade rejected by credibility gate: wallet=${wallet} resolvedBetCount=${resolvedBetCount ?? "N/A"} stakeUsd=${trade.size} avgEv=${walletStats?.avgEv ?? "N/A"} tradeEv=${tradeEvPercent ?? "N/A"} floor=${CREDIBILITY_CONFIG.MIN_RESOLVED_BETS}`
      );
      return false;
    }

    return true;
  });

  recordFeedMetrics({
    tradesDetected: stakeCandidates.length,
    gatePassedTrades: qualified.length,
    whaleWallets: qualified
      .map((trade) => trade.proxyWallet)
      .filter((wallet): wallet is string => Boolean(wallet)),
  });

  return qualified;
}

export async function enrichPolymarketFeedTradesWithIdentity<
  T extends PolymarketFeedTradeLike,
>(
  trades: Array<T & { marketTranslation?: MarketPositionTranslation }>
): Promise<
  Array<
    T & {
      whaleIdentity: ResolvedWhaleIdentity;
      marketTranslation: MarketPositionTranslation;
    }
  >
> {
  const wallets = trades
    .map((trade) => trade.proxyWallet?.trim().toLowerCase())
    .filter((wallet): wallet is string => Boolean(wallet));

  const qualifications = await qualifyWalletsForFeed(wallets);

  return trades.flatMap((trade) => {
    const marketTranslation =
      trade.marketTranslation ?? translateWhaleTradeMarket(trade);
    if (!marketTranslation) return [];

    const wallet = trade.proxyWallet?.trim().toLowerCase();
    const identity =
      wallet && qualifications[wallet]
        ? qualifications[wallet]!.identity
        : resolveWhaleIdentity(wallet ?? null);

    return [
      {
        ...trade,
        whaleIdentity: identity,
        marketTranslation,
      },
    ];
  });
}

export function recordKalshiFeedMetrics(detectedCount: number): void {
  recordFeedMetrics({
    tradesDetected: detectedCount,
    gatePassedTrades: 0,
  });
}
