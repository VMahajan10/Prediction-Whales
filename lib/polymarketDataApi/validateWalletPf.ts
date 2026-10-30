import { fetchAllV2PositionsForStatus } from "@/lib/polymarketDataApi/positions";
import {
  reconciliationGapPercent,
  reconciliationPasses,
} from "@/lib/polymarketDataApi/reconciliation";
import { fetchV2HeadlineRealizedPnl } from "@/lib/polymarketDataApi/userPnl";
import {
  computeWalletProfitFactorStats,
  type WalletProfitFactorStats,
} from "@/lib/walletProfitFactor";

export interface WalletPfValidationRow {
  wallet: string;
  closedCount: number;
  profitFactor: number | null;
  positionsSumClosedRealized: number;
  headlineRealizedPnl: number | null;
  reconciliationGapPct: number | null;
  reconciliationPassed: boolean;
  statsVerified: boolean;
}

/** Live API v2 validation (CLOSED positions + user-pnl headline). */
export async function validateWalletPfFromApi(
  wallet: string
): Promise<WalletPfValidationRow> {
  const w = wallet.toLowerCase();
  const closed = await fetchAllV2PositionsForStatus(w, "CLOSED");
  const positionsSumClosedRealized = closed.reduce(
    (s, r) => s + Number(r.realized_pnl ?? 0),
    0
  );
  const headlineRealizedPnl = await fetchV2HeadlineRealizedPnl(w);
  const reconciliationGapPct = headlineRealizedPnl != null
    ? reconciliationGapPercent(positionsSumClosedRealized, headlineRealizedPnl)
    : null;
  const reconciliationPassed = reconciliationPasses(reconciliationGapPct);

  const pfPositions = closed.map((r) => ({
    realizedPnl: Number(r.realized_pnl ?? 0),
    title: r.title ?? undefined,
    hasReliableTitle: false,
    hasReliableCategory: false,
  }));

  let stats: WalletProfitFactorStats;
  if (!reconciliationPassed) {
    stats = {
      availability: "unavailable",
      verified: false,
      overall: null,
      excludingBestTrade: null,
      byCategoryLabel: [],
      netRealizedPnl: positionsSumClosedRealized,
      headlineRealizedPnl,
      reconciliationGapPct,
      closedWinCount: null,
      closedLossCount: null,
      winRatePct: null,
    };
  } else {
    stats = computeWalletProfitFactorStats(pfPositions);
    stats = {
      ...stats,
      verified: true,
      headlineRealizedPnl,
      reconciliationGapPct,
      netRealizedPnl: headlineRealizedPnl ?? stats.netRealizedPnl,
    };
  }

  return {
    wallet: w,
    closedCount: closed.length,
    profitFactor: stats.overall?.profitFactor ?? null,
    positionsSumClosedRealized,
    headlineRealizedPnl,
    reconciliationGapPct,
    reconciliationPassed,
    statsVerified: stats.verified,
  };
}
