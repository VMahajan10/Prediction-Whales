import "server-only";

import { isDatabaseEnabled } from "@/lib/crossmarket/store/db";
import { computeWalletProfitFactorStatsFromDb } from "@/lib/polymarketDataApi/computeWalletProfitFactorFromDb";
import {
  isWalletPositionsSyncRunning,
  startBackgroundWalletPositionsSync,
} from "@/lib/polymarketDataApi/backgroundPositionsSync";
import {
  loadWalletApiSyncState,
  syncWalletApiPositions,
} from "@/lib/polymarketDataApi/positionsStore";
import {
  coalesceWalletProfitFactorStats,
  getCachedWalletProfitFactorStats,
  invalidateWalletProfitFactorStatsCache,
  peekMemoryWalletProfitFactorStats,
  setCachedWalletProfitFactorStats,
  WALLET_PF_STATS_CACHE_TTL_MS,
} from "@/lib/polymarketDataApi/profitFactorStatsCache";
import type { WalletProfitFactorStats } from "@/lib/walletProfitFactor";

const SYNC_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const FULL_SYNC_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Re-export for callers documenting cache behavior. */
export { WALLET_PF_STATS_CACHE_TTL_MS, invalidateWalletProfitFactorStatsCache };

function syncingStats(): WalletProfitFactorStats {
  return {
    availability: "syncing",
    verified: false,
    overall: null,
    excludingBestTrade: null,
    byCategoryLabel: [],
    netRealizedPnl: null,
    headlineRealizedPnl: null,
    reconciliationGapPct: null,
    closedWinCount: null,
    closedLossCount: null,
    winRatePct: null,
  };
}

function unavailableStats(): WalletProfitFactorStats {
  return {
    availability: "unavailable",
    verified: false,
    overall: null,
    excludingBestTrade: null,
    byCategoryLabel: [],
    netRealizedPnl: null,
    headlineRealizedPnl: null,
    reconciliationGapPct: null,
    closedWinCount: null,
    closedLossCount: null,
    winRatePct: null,
  };
}

function normalizeWallet(wallet: string): string {
  return wallet.toLowerCase();
}

async function resolveWalletProfitFactorStatsInner(
  wallet: string,
  options?: { forceSync?: boolean }
): Promise<WalletProfitFactorStats> {
  if (!isDatabaseEnabled()) return unavailableStats();

  const w = normalizeWallet(wallet);

  try {
    if (options?.forceSync) {
      invalidateWalletProfitFactorStatsCache(w);
      await syncWalletApiPositions(w, { forceFull: true });
    } else {
      const hot = peekMemoryWalletProfitFactorStats(w);
      if (hot) return hot;
    }

    const state = await loadWalletApiSyncState(w);

    // Read path never blocks on the Data API: missing or stale history is
    // refreshed in the background and the last reconciled snapshot is served.
    if (!options?.forceSync) {
      const now = Date.now();
      const neverFullySynced = !state?.lastFullSyncAt;
      const fullStale =
        !neverFullySynced &&
        now - state!.lastFullSyncAt!.getTime() > FULL_SYNC_MAX_AGE_MS;
      const stale =
        !state || now - state.updatedAt.getTime() > SYNC_MAX_AGE_MS;
      const running =
        state?.fullSyncStatus === "running" || isWalletPositionsSyncRunning(w);

      if (!running && (neverFullySynced || fullStale || stale)) {
        void startBackgroundWalletPositionsSync(w, {
          forceFull: neverFullySynced || fullStale,
        }).catch((err) =>
          console.warn("[profitFactor] background sync start failed", w, err)
        );
      }
      if (neverFullySynced || (running && !state?.reconciliationPassed)) {
        return syncingStats();
      }
    }

    const syncUpdatedAt = state?.updatedAt?.getTime() ?? 0;

    if (!options?.forceSync && syncUpdatedAt > 0) {
      const cached = await getCachedWalletProfitFactorStats(w, syncUpdatedAt);
      if (cached) return cached;
    }

    const stats = await computeWalletProfitFactorStatsFromDb(w, state);

    if (syncUpdatedAt > 0 && stats.availability === "verified") {
      await setCachedWalletProfitFactorStats(w, stats, syncUpdatedAt);
    }

    return stats;
  } catch (err) {
    console.warn("[profitFactor] API v2 load failed:", err);
    return unavailableStats();
  }
}

export async function resolveWalletProfitFactorStats(
  wallet: string,
  options?: { forceSync?: boolean }
): Promise<WalletProfitFactorStats> {
  const w = normalizeWallet(wallet);
  if (options?.forceSync) {
    return resolveWalletProfitFactorStatsInner(w, options);
  }
  return coalesceWalletProfitFactorStats(w, () =>
    resolveWalletProfitFactorStatsInner(w, options)
  );
}

/** Pre-warm PF stats cache after position sync (registry jobs). */
export async function warmWalletProfitFactorStatsCache(
  wallet: string
): Promise<WalletProfitFactorStats> {
  const w = normalizeWallet(wallet);
  invalidateWalletProfitFactorStatsCache(w);
  const state = await loadWalletApiSyncState(w);
  const syncUpdatedAt = state?.updatedAt?.getTime() ?? 0;
  const stats = await computeWalletProfitFactorStatsFromDb(w);
  if (syncUpdatedAt > 0 && stats.availability === "verified") {
    await setCachedWalletProfitFactorStats(w, stats, syncUpdatedAt);
  }
  return stats;
}
