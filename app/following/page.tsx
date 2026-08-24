"use client";

import { useMemo, useState } from "react";
import FeedEmptyState from "@/components/FeedEmptyState";
import MobileAppShell from "@/components/MobileAppShell";
import TraderAlertSync from "@/components/TraderAlertSync";
import WatchlistFilterSheet from "@/components/WatchlistFilterSheet";
import WatchlistTraderCard from "@/components/WatchlistTraderCard";
import { LiveFeedPlatformProvider } from "@/lib/LiveFeedPlatformContext";
import { useWhaleFeed } from "@/lib/useWhaleFeed";
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
      <header className="mb-4 flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-white">Watchlist</h1>
        <span className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide text-pulse-yes">
          <span className="h-1.5 w-1.5 rounded-full bg-pulse-yes" />
          Live
        </span>
      </header>

      <div className="mb-5 flex justify-end">
        <button
          type="button"
          onClick={() => setSheetOpen(true)}
          className="inline-flex items-center gap-2 rounded-lg border border-pulse-accent px-3 py-2 text-[10px] font-bold uppercase tracking-wide text-pulse-accent"
        >
          <span>⇅ Filters / Sort</span>
          {activeFilterCount > 0 ? (
            <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-pulse-accent px-1 text-[9px] font-bold text-white">
              {activeFilterCount}
            </span>
          ) : null}
          <span aria-hidden>▾</span>
        </button>
      </div>

      {bookmarks.length === 0 ? (
        <FeedEmptyState
          icon="◎"
          title="No whales on your watchlist"
          description="Star a whale from the feed to track their plays, win rate, and open positions here."
          actionLabel="Browse Whale Feed"
          actionHref="/"
        />
      ) : filtered.length === 0 ? (
        <div className="rounded-2xl border border-pulse-border bg-pulse-card px-6 py-14 text-center">
          <div className="mb-4 flex h-16 w-16 mx-auto items-center justify-center rounded-full border border-pulse-border bg-pulse-surface text-3xl">
            ⇅
          </div>
          <p className="text-base font-bold text-white">No matches for these filters</p>
          <p className="mt-2 text-sm text-pulse-muted">
            Try resetting filters or widening your selections.
          </p>
          <button
            type="button"
            onClick={() => setFilters(DEFAULT_WATCHLIST_FILTERS)}
            className="mt-6 inline-flex items-center justify-center rounded-xl bg-pulse-accent px-5 py-2.5 text-sm font-bold text-black"
          >
            Reset Filters
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
  const { whales } = useWhaleFeed();

  return (
    <LiveFeedPlatformProvider>
      <MobileAppShell>
        <TraderAlertSync whales={whales} />
        <WatchlistContent />
      </MobileAppShell>
    </LiveFeedPlatformProvider>
  );
}
