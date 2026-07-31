"use client";

import { useEffect, useMemo, useState } from "react";
import type { BookmarkedTrader } from "@/lib/bookmarkedTraders";
import { repairTrackRecord, type TrackRecord } from "@/lib/polymarket";
import type { TraderOpenPosition } from "@/lib/traderProfile";
import type { WatchlistProfile } from "@/lib/watchlistFilters";

interface ProfileFetchResult {
  trackRecord: TrackRecord | null;
  openPositions: TraderOpenPosition[];
  avgEv: number | null;
}

export function useWatchlistProfiles(bookmarks: BookmarkedTrader[]) {
  const [profilesByWallet, setProfilesByWallet] = useState<
    Record<string, ProfileFetchResult>
  >({});
  const [loading, setLoading] = useState(false);

  const walletKey = bookmarks.map((b) => b.wallet).join("|");

  useEffect(() => {
    if (bookmarks.length === 0) {
      setProfilesByWallet({});
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);

    const load = async () => {
      const entries = await Promise.all(
        bookmarks.map(async (trader) => {
          try {
            const res = await fetch(
              `/api/whale-track-record?wallet=${encodeURIComponent(trader.wallet)}`
            );
            if (!res.ok) {
              return [
                trader.wallet,
                { trackRecord: null, openPositions: [], avgEv: null },
              ] as const;
            }
            const data = await res.json();
            return [
              trader.wallet,
              {
                trackRecord: data.trackRecord
                  ? repairTrackRecord(data.trackRecord)
                  : null,
                openPositions: data.openPositions ?? [],
                avgEv: data.pipelineEvAnalytics?.averageEv ?? null,
              },
            ] as const;
          } catch {
            return [
              trader.wallet,
              { trackRecord: null, openPositions: [], avgEv: null },
            ] as const;
          }
        })
      );

      if (cancelled) return;

      setProfilesByWallet(Object.fromEntries(entries));
      setLoading(false);
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [walletKey]);

  const profiles: WatchlistProfile[] = useMemo(
    () =>
      bookmarks.map((trader) => {
        const fetched = profilesByWallet[trader.wallet];
        return {
          trader,
          trackRecord: fetched?.trackRecord ?? null,
          openPositionCount: fetched?.openPositions.length ?? 0,
          openPositions: fetched?.openPositions ?? [],
          avgEv: fetched?.avgEv ?? null,
          loading: loading && !fetched,
        };
      }),
    [bookmarks, profilesByWallet, loading]
  );

  return { profiles, loading };
}
