"use client";

import {
  LEDGER_STATS_UNVERIFIED_LABEL,
  WALLET_POSITIONS_SYNCING_LABEL,
  isProfitFactorStatsVerified,
} from "@/lib/walletLedger/ledgerDerivedStatsGate";
import {
  formatProfitFactorLine,
  formatProfitFactorLineOrUnavailable,
  formatProfitFactorSummary,
  formatProfitFactorUnavailable,
  formatProfitFactorValue,
  profitFactorSliceForCategoryFilter,
  type ProfitFactorCategoryFilter,
  type WalletProfitFactorStats,
} from "@/lib/walletProfitFactor";

interface WalletProfitFactorStatsProps {
  stats: WalletProfitFactorStats | null;
  categoryFilter: ProfitFactorCategoryFilter;
  className?: string;
}

export function WalletProfitFactorStatsBlock({
  stats,
  categoryFilter,
  className = "",
}: WalletProfitFactorStatsProps) {
  const overall = profitFactorSliceForCategoryFilter(stats, "all");
  const categorySlice = profitFactorSliceForCategoryFilter(
    stats,
    categoryFilter
  );
  const exBest = stats?.excludingBestTrade ?? null;

  const verified = isProfitFactorStatsVerified(stats);
  const syncing = stats?.availability === "syncing";
  const unavailable = !verified || !stats || !overall;

  if (syncing) {
    return (
      <div className={`space-y-1 text-xs text-pulse-muted ${className}`}>
        <p className="font-semibold text-white">
          PF {formatProfitFactorUnavailable()}
        </p>
        <p className="text-[10px] text-pulse-label">
          {WALLET_POSITIONS_SYNCING_LABEL}
        </p>
      </div>
    );
  }

  if (unavailable) {
    return (
      <div className={`space-y-1 text-xs text-pulse-muted ${className}`}>
        <p className="font-semibold text-white">
          PF {formatProfitFactorUnavailable()}
        </p>
        <p className="text-[10px] text-pulse-label">
          {LEDGER_STATS_UNVERIFIED_LABEL}
        </p>
      </div>
    );
  }

  return (
    <div className={`space-y-1.5 text-xs text-pulse-muted ${className}`}>
      <p className="font-semibold text-white">
        {categoryFilter === "all"
          ? formatProfitFactorLine(overall)
          : categorySlice
            ? formatProfitFactorSummary(categorySlice, overall)
            : `${formatProfitFactorLineOrUnavailable(stats, null)} · ${formatProfitFactorLine(overall)}`}
      </p>
      {categoryFilter !== "all" && !categorySlice ? (
        <p className="text-[10px] text-amber-200/90">
          Category PF {formatProfitFactorUnavailable()} (need tagged positions).
        </p>
      ) : null}
      <p>
        PF ex. best trade:{" "}
        <span className="text-white">
          {exBest
            ? formatProfitFactorValue(exBest.profitFactor)
            : formatProfitFactorUnavailable()}
        </span>
        {exBest ? (
          <span className="text-pulse-label">
            {" "}
            (overall, {exBest.positionCount.toLocaleString()} positions)
          </span>
        ) : null}
      </p>
      {overall.limitedData ? (
        <p className="font-semibold text-amber-300/90">Limited data.</p>
      ) : null}
    </div>
  );
}
