"use client";

import { useEffect, useState } from "react";
import type { MarketSummary } from "@/lib/polymarket";
import MarketCard from "@/components/MarketCard";

interface MarketFeedProps {
  markets: MarketSummary[];
  loading: boolean;
  error: string | null;
  lastUpdated: Date | null;
  onRetry: () => void;
  explorerMode?: boolean;
}

export default function MarketFeed({
  markets,
  loading,
  error,
  lastUpdated,
  onRetry,
  explorerMode = false,
}: MarketFeedProps) {
  const [secondsAgo, setSecondsAgo] = useState(0);

  useEffect(() => {
    if (!lastUpdated) return;

    const tick = () => {
      setSecondsAgo(
        Math.floor((Date.now() - lastUpdated.getTime()) / 1000)
      );
    };

    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [lastUpdated]);

  if (loading && markets.length === 0) {
    return (
      <div className="flex items-center justify-center py-16">
        <p className="text-pulse-muted animate-pulse">Loading markets…</p>
      </div>
    );
  }

  if (error && markets.length === 0) {
    return (
      <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-6 text-center">
        <p className="text-red-400">{error}</p>
        <button
          type="button"
          onClick={onRetry}
          className="mt-4 rounded-lg bg-pulse-accent px-4 py-2 text-sm font-medium text-white hover:bg-blue-600"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <p className="text-sm text-pulse-muted">
          {markets.length} active markets
        </p>
        {lastUpdated && (
          <p className="text-sm text-pulse-muted">
            Last updated:{" "}
            <span className="text-white">{secondsAgo}</span> seconds ago
          </p>
        )}
      </div>

      {error && (
        <p className="mb-4 text-sm text-amber-400">
          Refresh failed: {error}. Showing cached data.
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {markets.map((market) => (
          <MarketCard
            key={market.id}
            market={market}
            explorerMode={explorerMode}
          />
        ))}
      </div>
    </div>
  );
}
