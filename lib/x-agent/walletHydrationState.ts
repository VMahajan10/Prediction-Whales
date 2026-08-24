import type { WhaleRegistry } from "@/lib/crossmarket/store/schema";

export const WALLET_HYDRATION_STATUSES = [
  "pending",
  "complete",
  "failed",
] as const;

export type WalletHydrationStatus = (typeof WALLET_HYDRATION_STATUSES)[number];

export function isWalletHydrationStatus(
  value: string | null | undefined
): value is WalletHydrationStatus {
  return (
    value === "pending" ||
    value === "complete" ||
    value === "failed"
  );
}

/** True when every credibility metric is still at schema defaults. */
export function isLegacyRegistryShellRow(whale: WhaleRegistry): boolean {
  return (
    (whale.resolvedBetsCount ?? 0) === 0 &&
    (whale.avgEv ?? 0) === 0 &&
    (whale.winRate ?? 0) === 0 &&
    (whale.avgStakeNotional ?? 0) === 0
  );
}

/**
 * Conservative legacy inference for rows created before hydration_status existed.
 * Prefer the persisted column when present.
 */
export function inferLegacyHydrationStatus(
  whale: WhaleRegistry
): WalletHydrationStatus {
  if (isLegacyRegistryShellRow(whale)) {
    return "pending";
  }

  if ((whale.resolvedBetsCount ?? 0) > 0) {
    return "complete";
  }

  // Enqueue stake/EV hints without resolved-bet history — not a completed hydration.
  return "pending";
}

export function resolveWalletHydrationStatus(
  whale: WhaleRegistry | null | undefined
): WalletHydrationStatus {
  if (!whale) return "pending";
  if (isWalletHydrationStatus(whale.hydrationStatus)) {
    return whale.hydrationStatus;
  }
  return inferLegacyHydrationStatus(whale);
}

export function walletNeedsHistoryHydration(
  whale: WhaleRegistry | null | undefined
): boolean {
  const status = resolveWalletHydrationStatus(whale);
  return status === "pending" || status === "failed";
}

export function walletHydrationBlocksFeedCredibility(
  whale: WhaleRegistry | null | undefined
): boolean {
  return resolveWalletHydrationStatus(whale) !== "complete";
}
