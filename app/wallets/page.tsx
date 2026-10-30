"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import MobileAppShell from "@/components/MobileAppShell";
import WatchlistFilterSheet from "@/components/WatchlistFilterSheet";
import {
  countActiveWatchlistFilters,
  DEFAULT_WATCHLIST_FILTERS,
  type WatchlistFilters,
} from "@/lib/watchlistFilters";

interface DirectoryWallet {
  wallet: string;
  displayName: string;
  winRate: number | null;
  roi: number | null;
  totalRealizedPnl: number | null;
  positionCount: number;
  profitFactor: number | null;
  profitFactorDisplay: string;
  limitedData: boolean;
}

export default function WalletsPage() {
  const [filters, setFilters] = useState<WatchlistFilters>(
    DEFAULT_WATCHLIST_FILTERS
  );
  const [sheetOpen, setSheetOpen] = useState(false);
  const [wallets, setWallets] = useState<DirectoryWallet[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const params = new URLSearchParams({
      minPf: String(filters.minProfitFactor),
      minPositions: String(filters.minPositionCount),
      category: filters.market,
      sort: filters.sort,
    });
    void fetch(`/api/wallets/directory?${params}`)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        setWallets(data.wallets ?? []);
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) {
          setWallets([]);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [
    filters.minProfitFactor,
    filters.minPositionCount,
    filters.market,
    filters.sort,
  ]);

  const activeFilterCount = countActiveWatchlistFilters(filters);
  const filteredCount = wallets.length;

  const subtitle = useMemo(() => {
    const pfLabel =
      filters.minProfitFactor > 0
        ? `PF ≥ ${filters.minProfitFactor}`
        : "any PF";
    return `${pfLabel} · ≥ ${filters.minPositionCount} positions · ${filters.market === "all" ? "all categories" : filters.market}`;
  }, [filters]);

  return (
    <MobileAppShell>
      <main className="min-h-screen px-4 py-5">
        <header className="mb-4">
          <h1 className="text-2xl font-bold text-white">Wallet stats</h1>
          <p className="mt-1 text-xs text-pulse-muted">{subtitle}</p>
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
          </button>
        </div>

        {loading ? (
          <p className="text-sm text-pulse-muted">Loading wallet stats…</p>
        ) : wallets.length === 0 ? (
          <p className="text-sm text-pulse-muted">
            No wallets match these filters.
          </p>
        ) : (
          <ul className="space-y-3">
            {wallets.map((w) => (
              <li key={w.wallet}>
                <Link
                  href={`/traders/${encodeURIComponent(w.wallet)}`}
                  className="block rounded-2xl border border-pulse-border bg-pulse-card p-4"
                >
                  <p className="font-bold text-white">{w.displayName}</p>
                  <p className="mt-2 text-sm text-white">
                    PF {w.profitFactorDisplay} ({filters.market === "all" ? "All" : filters.market},{" "}
                    {w.positionCount} positions)
                  </p>
                  <p className="mt-1 text-xs text-pulse-muted">
                    Ledger PnL:{" "}
                    {w.totalRealizedPnl != null
                      ? `$${Math.round(w.totalRealizedPnl).toLocaleString()}`
                      : "—"}{" "}
                    · Win rate (API track):{" "}
                    {w.winRate != null ? `${Math.round(w.winRate)}%` : "—"}
                  </p>
                  {w.limitedData ? (
                    <p className="mt-2 text-xs font-semibold text-amber-300/90">
                      Limited data.
                    </p>
                  ) : null}
                </Link>
              </li>
            ))}
          </ul>
        )}

        <WatchlistFilterSheet
          open={sheetOpen}
          filters={filters}
          resultCount={filteredCount}
          onChange={setFilters}
          onClose={() => setSheetOpen(false)}
        />
      </main>
    </MobileAppShell>
  );
}
