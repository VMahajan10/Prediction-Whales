import "server-only";

import {
  isQualifiedFeedTrade,
  isQualifiedWalletForFeed,
  meetsFeedStakeThreshold,
  type WalletFeedQualificationInput,
} from "@/lib/feedQualification";
import { recordFeedMetrics } from "@/lib/feedMetrics";
import { findWhaleByWalletCaseInsensitive } from "@/lib/x-agent/whaleRegistryDb";

export interface WalletFeedQualification extends WalletFeedQualificationInput {
  qualified: boolean;
}

export async function qualifyWalletForFeed(
  walletAddress: string
): Promise<WalletFeedQualification> {
  const whale = await findWhaleByWalletCaseInsensitive(walletAddress);
  if (!whale) {
    return { qualified: false, avgEv: null, resolvedBetsCount: null };
  }

  const stats = {
    avgEv: whale.avgEv,
    resolvedBetsCount: whale.resolvedBetsCount,
  };

  return {
    qualified: isQualifiedWalletForFeed(stats),
    ...stats,
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
  size: number;
  proxyWallet?: string | null;
}

export async function filterQualifiedPolymarketFeedTrades<
  T extends PolymarketFeedTradeLike,
>(trades: T[]): Promise<T[]> {
  const stakeCandidates = trades.filter((trade) =>
    meetsFeedStakeThreshold(trade.size)
  );

  const wallets = stakeCandidates
    .map((trade) => trade.proxyWallet?.trim().toLowerCase())
    .filter((wallet): wallet is string => Boolean(wallet));

  const qualifications = await qualifyWalletsForFeed(wallets);

  const qualified = stakeCandidates.filter((trade) => {
    const wallet = trade.proxyWallet?.trim().toLowerCase();
    if (!wallet) return false;
    const walletStats = qualifications[wallet];
    return isQualifiedFeedTrade({
      stakeUsd: trade.size,
      walletAvgEv: walletStats?.avgEv,
      resolvedBetsCount: walletStats?.resolvedBetsCount,
    });
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

export function recordKalshiFeedMetrics(detectedCount: number): void {
  recordFeedMetrics({
    tradesDetected: detectedCount,
    gatePassedTrades: 0,
  });
}
