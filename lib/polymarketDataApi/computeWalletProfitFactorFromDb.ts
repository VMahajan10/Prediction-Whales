import "server-only";

import {
  loadCachedClosedPositions,
  loadWalletApiSyncState,
} from "@/lib/polymarketDataApi/positionsStore";
import {
  computeWalletProfitFactorStats,
  profitFactorExcludingBestTradeSlice,
  type ProfitFactorPosition,
  type WalletProfitFactorStats,
} from "@/lib/walletProfitFactor";

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

function closedPositionsToPfRows(
  rows: Awaited<ReturnType<typeof loadCachedClosedPositions>>
): ProfitFactorPosition[] {
  return rows.map((r) => ({
    realizedPnl: r.realizedPnl,
    title: r.title ?? undefined,
    categoryLabel: r.categoryLabel ?? undefined,
    hasReliableTitle: Boolean(r.title?.trim()),
    hasReliableCategory: Boolean(r.categoryLabel?.trim()),
  }));
}

/** Build verified PF stats from DB cache (no API sync). */
export async function computeWalletProfitFactorStatsFromDb(
  wallet: string,
  preloadedState?: Awaited<ReturnType<typeof loadWalletApiSyncState>>
): Promise<WalletProfitFactorStats> {
  const sync =
    preloadedState !== undefined
      ? preloadedState
      : await loadWalletApiSyncState(wallet);
  if (!sync?.reconciliationPassed) {
    return {
      ...unavailableStats(),
      headlineRealizedPnl: sync?.headlineRealizedPnl ?? null,
      reconciliationGapPct: sync?.reconciliationGapPct ?? null,
      netRealizedPnl: sync?.positionsSumClosedRealized ?? null,
    };
  }

  const closed = await loadCachedClosedPositions(wallet);
  const positions = closedPositionsToPfRows(closed);
  if (positions.length === 0) return unavailableStats();

  const computed = computeWalletProfitFactorStats(positions);
  if (!computed.overall) return unavailableStats();
  const overall = computed.overall;
  const excludingBestTrade = profitFactorExcludingBestTradeSlice(positions);

  return {
    availability: "verified",
    verified: true,
    overall,
    excludingBestTrade,
    byCategoryLabel: computed.byCategoryLabel,
    netRealizedPnl:
      sync.headlineRealizedPnl ?? overall.grossProfit - overall.grossLoss,
    headlineRealizedPnl: sync.headlineRealizedPnl,
    reconciliationGapPct: sync.reconciliationGapPct,
    closedWinCount: overall.winCount,
    closedLossCount: overall.lossCount,
    winRatePct: overall.winRatePct,
  };
}
