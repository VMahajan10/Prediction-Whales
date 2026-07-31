import "server-only";

import {
  isQualifiedWalletForFeed,
  type WalletFeedQualificationInput,
} from "@/lib/feedQualification";
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
