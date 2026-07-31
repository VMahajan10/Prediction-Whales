import {
  MIN_AVG_EV_THRESHOLD,
  MIN_STAKE_THRESHOLD,
  meetsResolvedBetsThreshold,
} from "@/lib/x-agent/gateMetrics";
import { findWhaleByWalletCaseInsensitive } from "@/lib/x-agent/whaleRegistryDb";

export { MIN_AVG_EV_THRESHOLD, MIN_STAKE_THRESHOLD };

export function meetsFeedStakeThreshold(stakeUsd: number): boolean {
  return Number.isFinite(stakeUsd) && stakeUsd >= MIN_STAKE_THRESHOLD;
}

export function meetsWalletAvgEvThreshold(
  avgEv: number | null | undefined
): boolean {
  return (
    avgEv != null && Number.isFinite(avgEv) && avgEv >= MIN_AVG_EV_THRESHOLD
  );
}

export interface FeedQualificationInput {
  stakeUsd: number;
  walletAvgEv?: number | null;
  resolvedBetsCount?: number | null;
}

/** Synchronous feed qualification when wallet stats are already known. */
export function isQualifiedFeedTrade(input: FeedQualificationInput): boolean {
  if (!meetsFeedStakeThreshold(input.stakeUsd)) return false;

  if (
    input.resolvedBetsCount != null &&
    !meetsResolvedBetsThreshold(input.resolvedBetsCount)
  ) {
    return false;
  }

  if (input.walletAvgEv != null && !meetsWalletAvgEvThreshold(input.walletAvgEv)) {
    return false;
  }

  return true;
}

export interface WalletFeedQualification {
  qualified: boolean;
  avgEv: number | null;
  resolvedBetsCount: number | null;
}

export async function qualifyWalletForFeed(
  walletAddress: string
): Promise<WalletFeedQualification> {
  const whale = await findWhaleByWalletCaseInsensitive(walletAddress);
  if (!whale) {
    return { qualified: false, avgEv: null, resolvedBetsCount: null };
  }

  const qualified =
    meetsResolvedBetsThreshold(whale.resolvedBetsCount) &&
    meetsWalletAvgEvThreshold(whale.avgEv);

  return {
    qualified,
    avgEv: whale.avgEv,
    resolvedBetsCount: whale.resolvedBetsCount,
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
    unique.map(async (wallet) => [wallet, await qualifyWalletForFeed(wallet)] as const)
  );

  return Object.fromEntries(entries);
}
