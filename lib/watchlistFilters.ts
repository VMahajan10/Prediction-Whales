import {
  inferCategoryBadge,
  inferMarketCategory,
  type MarketCategory,
} from "@/lib/marketCategory";
import type { BookmarkedTrader } from "@/lib/bookmarkedTraders";
import type { TrackRecord } from "@/lib/polymarket";
import type { TraderOpenPosition } from "@/lib/traderProfile";
import {
  DEFAULT_MIN_POSITION_COUNT,
  DIRECTORY_DEFAULT_MIN_PROFIT_FACTOR,
  profitFactorSliceForCategoryFilter,
  type ProfitFactorCategoryFilter,
  type WalletProfitFactorStats,
} from "@/lib/walletProfitFactor";

export type WatchlistSort =
  | "recently_active"
  | "highest_win_rate"
  | "most_open_positions"
  | "top_roi"
  | "highest_ev"
  | "highest_profit_factor"
  | "top_pnl"
  | "most_positions";

export type WatchlistMarketFilter = "all" | MarketCategory | "NFL" | "NBA" | "MLB";

export type WatchlistPlatformFilter = "all" | "kalshi" | "polymarket";

export interface WatchlistFilters {
  sort: WatchlistSort;
  market: WatchlistMarketFilter;
  platform: WatchlistPlatformFilter;
  alerts: "on" | "off";
  onlyOpenPlay: boolean;
  minProfitFactor: number;
  minPositionCount: number;
}

export interface WatchlistProfile {
  trader: BookmarkedTrader;
  trackRecord: TrackRecord | null;
  openPositionCount: number;
  openPositions: TraderOpenPosition[];
  avgEv: number | null;
  profitFactorStats: WalletProfitFactorStats | null;
  loading: boolean;
}

export const DEFAULT_WATCHLIST_FILTERS: WatchlistFilters = {
  sort: "highest_profit_factor",
  market: "all",
  platform: "all",
  alerts: "on",
  onlyOpenPlay: false,
  minProfitFactor: DIRECTORY_DEFAULT_MIN_PROFIT_FACTOR,
  minPositionCount: DEFAULT_MIN_POSITION_COUNT,
};

export function countActiveWatchlistFilters(
  filters: WatchlistFilters
): number {
  let count = 0;
  if (filters.sort !== DEFAULT_WATCHLIST_FILTERS.sort) count += 1;
  if (filters.market !== "all") count += 1;
  if (filters.platform !== "all") count += 1;
  if (filters.alerts !== "on") count += 1;
  if (filters.onlyOpenPlay) count += 1;
  if (filters.minProfitFactor !== DIRECTORY_DEFAULT_MIN_PROFIT_FACTOR) count += 1;
  if (filters.minPositionCount !== DEFAULT_MIN_POSITION_COUNT) count += 1;
  return count;
}

function latestActivityAt(profile: WatchlistProfile): number {
  const fromPositions = profile.openPositions.reduce(
    (max, p) => Math.max(max, 0),
    0
  );
  return Math.max(
    profile.trader.bookmarkedAt,
    fromPositions,
    profile.trader.lastSeenTxHash ? profile.trader.bookmarkedAt : 0
  );
}

function matchesMarketFilter(
  profile: WatchlistProfile,
  market: WatchlistMarketFilter
): boolean {
  if (market === "all") return true;
  const pfSlice = profitFactorSliceForFilter(profile, market);
  if (pfSlice && pfSlice.positionCount > 0) return true;
  return profile.openPositions.some((p) => {
    if (market === "NFL" || market === "NBA" || market === "MLB") {
      return inferCategoryBadge(p.title).label === market;
    }
    return inferMarketCategory(p.title) === market;
  });
}

function matchesPlatformFilter(
  profile: WatchlistProfile,
  platform: WatchlistPlatformFilter
): boolean {
  if (platform === "all") return true;
  if (platform === "polymarket") return true;
  return false;
}

function matchesAlertsFilter(
  profile: WatchlistProfile,
  alerts: "on" | "off"
): boolean {
  const enabled = profile.trader.alertsEnabled !== false;
  return alerts === "on" ? enabled : !enabled;
}

export function profitFactorSliceForFilter(
  profile: WatchlistProfile,
  market: ProfitFactorCategoryFilter
) {
  return profitFactorSliceForCategoryFilter(profile.profitFactorStats, market);
}

function passesProfitFactorFilters(
  profile: WatchlistProfile,
  filters: WatchlistFilters
): boolean {
  const slice = profitFactorSliceForFilter(profile, filters.market);
  if (!slice) return false;
  if (slice.positionCount < filters.minPositionCount) return false;
  if (slice.profitFactor == null) {
    return filters.minProfitFactor <= 0;
  }
  return slice.profitFactor >= filters.minProfitFactor;
}

export function applyWatchlistFilters(
  profiles: WatchlistProfile[],
  filters: WatchlistFilters
): WatchlistProfile[] {
  let rows = profiles.filter((profile) => {
    if (filters.onlyOpenPlay && profile.openPositionCount === 0) return false;
    if (!matchesMarketFilter(profile, filters.market)) return false;
    if (!matchesPlatformFilter(profile, filters.platform)) return false;
    if (!matchesAlertsFilter(profile, filters.alerts)) return false;
    if (!passesProfitFactorFilters(profile, filters)) return false;
    return true;
  });

  rows = [...rows].sort((a, b) => {
    const sliceA = profitFactorSliceForFilter(a, filters.market);
    const sliceB = profitFactorSliceForFilter(b, filters.market);
    switch (filters.sort) {
      case "highest_profit_factor":
        return (
          (sliceB?.profitFactor ?? -1) - (sliceA?.profitFactor ?? -1)
        );
      case "most_positions":
        return (sliceB?.positionCount ?? 0) - (sliceA?.positionCount ?? 0);
      case "top_pnl":
        return (
          (b.trackRecord?.totalRealizedPnl ?? -Infinity) -
          (a.trackRecord?.totalRealizedPnl ?? -Infinity)
        );
      case "highest_win_rate":
        return (sliceB?.winRatePct ?? -1) - (sliceA?.winRatePct ?? -1);
      case "most_open_positions":
        return b.openPositionCount - a.openPositionCount;
      case "top_roi":
        return (b.trackRecord?.roi ?? -Infinity) - (a.trackRecord?.roi ?? -1);
      case "highest_ev":
        return (b.avgEv ?? -Infinity) - (a.avgEv ?? -Infinity);
      case "recently_active":
      default:
        return latestActivityAt(b) - latestActivityAt(a);
    }
  });

  return rows;
}

export function formatWinRate(winRate: number | null | undefined): string {
  if (winRate == null || !Number.isFinite(winRate)) return "—";
  const pct = winRate <= 1 ? winRate * 100 : winRate;
  return `${Math.round(pct)}%`;
}

export function formatRoi(roi: number | null | undefined): string {
  if (roi == null || !Number.isFinite(roi)) return "—";
  const pct = roi <= 1 ? roi * 100 : roi;
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${Math.round(pct)}%`;
}

export function roiColorClass(roi: number | null | undefined): string {
  if (roi == null || !Number.isFinite(roi)) return "text-white";
  const pct = roi <= 1 ? roi * 100 : roi;
  return pct >= 0 ? "text-pulse-yes" : "text-pulse-no";
}

export function formatAvgEv(avgEv: number | null | undefined): string {
  if (avgEv == null || !Number.isFinite(avgEv)) return "—";
  const pct = avgEv <= 1 ? avgEv * 100 : avgEv;
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}
