import type { WalletProfitFactorStats } from "@/lib/walletProfitFactor";

/** Shown when per-wallet API v2 reconciliation has not passed yet. */
export const LEDGER_STATS_UNVERIFIED_LABEL = "Data being verified.";

/** Shown while a large wallet position history sync is running in the background. */
export const WALLET_POSITIONS_SYNCING_LABEL = "Syncing history…";

/** @deprecated Ledger/env gate removed — use `isProfitFactorStatsVerified(stats)`. */
export function isLedgerDerivedStatsVerified(): boolean {
  return false;
}

export function isProfitFactorStatsVerified(
  stats?: WalletProfitFactorStats | null
): boolean {
  return stats?.verified === true;
}
