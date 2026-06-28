import { inferMarketCategory, type MarketCategory } from "@/lib/marketCategory";
import type { BookmarkedTrader } from "@/lib/bookmarkedTraders";
import type { TraderOpenPosition } from "@/lib/traderProfile";
import type { TrackRecord } from "@/lib/polymarket";

export type WatchlistSort =
  | "recently_active"
  | "highest_win_rate"
  | "most_open_positions"
  | "top_roi";

export type WatchlistMarketFilter = "all" | MarketCategory;

export type WatchlistPlatformFilter = "all" | "kalshi" | "polymarket";

export interface WatchlistFilters {
  sort: WatchlistSort;
  market: WatchlistMarketFilter;
  platform: WatchlistPlatformFilter;
  alerts: "on" | "off";
  onlyOpenPlay: boolean;
}

export interface WatchlistProfile {
  trader: BookmarkedTrader;
  trackRecord: TrackRecord | null;
  openPositionCount: number;
  openPositions: TraderOpenPosition[];
  loading: boolean;
}

export const DEFAULT_WATCHLIST_FILTERS: WatchlistFilters = {
  sort: "recently_active",
  market: "all",
  platform: "all",
  alerts: "on",
  onlyOpenPlay: false,
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
  return profile.openPositions.some(
    (p) => inferMarketCategory(p.title) === market
  );
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

export function applyWatchlistFilters(
  profiles: WatchlistProfile[],
  filters: WatchlistFilters
): WatchlistProfile[] {
  let rows = profiles.filter((profile) => {
    if (filters.onlyOpenPlay && profile.openPositionCount === 0) return false;
    if (!matchesMarketFilter(profile, filters.market)) return false;
    if (!matchesPlatformFilter(profile, filters.platform)) return false;
    if (!matchesAlertsFilter(profile, filters.alerts)) return false;
    return true;
  });

  rows = [...rows].sort((a, b) => {
    switch (filters.sort) {
      case "highest_win_rate":
        return (
          (b.trackRecord?.winRate ?? -1) - (a.trackRecord?.winRate ?? -1)
        );
      case "most_open_positions":
        return b.openPositionCount - a.openPositionCount;
      case "top_roi":
        return (b.trackRecord?.roi ?? -Infinity) - (a.trackRecord?.roi ?? -1);
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
  return `+${Math.round(pct)}%`;
}

export function formatRoi(roi: number | null | undefined): string {
  if (roi == null || !Number.isFinite(roi)) return "—";
  const pct = roi <= 1 ? roi * 100 : roi;
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${Math.round(pct)}%`;
}
