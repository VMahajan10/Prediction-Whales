"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import MobileAppShell from "@/components/MobileAppShell";
import TraderAlertSync from "@/components/TraderAlertSync";
import WatchlistFilterSheet from "@/components/WatchlistFilterSheet";
import WatchlistTraderCard from "@/components/WatchlistTraderCard";
import { LiveFeedPlatformProvider } from "@/lib/LiveFeedPlatformContext";
import { useBookmarkedTraders } from "@/lib/useBookmarkedTraders";
import { useWatchlistProfiles } from "@/lib/useWatchlistProfiles";
import {
  applyWatchlistFilters,
  countActiveWatchlistFilters,
  DEFAULT_WATCHLIST_FILTERS,
  type WatchlistFilters,
} from "@/lib/watchlistFilters";

function WatchlistContent() {
  const { bookmarks } = useBookmarkedTraders();
  const { profiles } = useWatchlistProfiles(bookmarks);
  const [filters, setFilters] = useState<WatchlistFilters>(
    DEFAULT_WATCHLIST_FILTERS
  );
  const [sheetOpen, setSheetOpen] = useState(false);

  const filtered = useMemo(
    () => applyWatchlistFilters(profiles, filters),
    [profiles, filters]
  );
  const activeFilterCount = countActiveWatchlistFilters(filters);

  return (
    <main className="min-h-screen px-4 py-5">
      <header className="mb-5 flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-white">Watchlist</h1>
        <span className="flex items-center gap-1.5 rounded bg-pulse-yes/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-pulse-yes">
          <span className="h-1.5 w-1.5 rounded-full bg-pulse-yes" />
          Live
        </span>
      </header>

      <button
        type="button"
        onClick={() => setSheetOpen(true)}
        className="mb-5 flex w-full items-center justify-center gap-2 rounded-pulse border border-pulse-border bg-pulse-card py-3 text-[11px] font-bold uppercase tracking-wide text-white"
      >
        <span>↑↓ Filters / sort</span>
        {activeFilterCount > 0 && (
          <span className="rounded-full bg-pulse-accent px-1.5 py-0.5 text-[10px] text-white">
            {activeFilterCount}
          </span>
        )}
      </button>

      {bookmarks.length === 0 ? (
        <div className="pulse-card px-6 py-12 text-center">
          <p className="text-3xl">◎</p>
          <p className="mt-3 text-sm text-pulse-muted">
            No whales on your watchlist yet
          </p>
          <p className="mt-2 text-xs text-pulse-label">
            Star a Polymarket whale on the feed to track them here
          </p>
          <Link
            href="/"
            className="mt-5 inline-block text-sm font-semibold text-pulse-accent"
          >
            Go to whale feed →
          </Link>
        </div>
      ) : filtered.length === 0 ? (
        <div className="pulse-card px-6 py-10 text-center">
          <p className="text-sm text-pulse-muted">
            No whales match these filters
          </p>
          <button
            type="button"
            onClick={() => setFilters(DEFAULT_WATCHLIST_FILTERS)}
            className="mt-4 text-sm font-semibold text-pulse-accent"
          >
            Reset filters
          </button>
        </div>
      ) : (
        <ul className="space-y-3">
          {filtered.map((profile) => (
            <li key={profile.trader.wallet}>
              <WatchlistTraderCard profile={profile} />
            </li>
          ))}
        </ul>
      )}

      <WatchlistFilterSheet
        open={sheetOpen}
        filters={filters}
        resultCount={filtered.length}
        onChange={setFilters}
        onClose={() => setSheetOpen(false)}
      />
    </main>
  );
}

export default function FollowingPage() {
  return (
    <LiveFeedPlatformProvider>
      <MobileAppShell>
        <TraderAlertSync />
        <WatchlistContent />
      </MobileAppShell>
    </LiveFeedPlatformProvider>
  );
}
