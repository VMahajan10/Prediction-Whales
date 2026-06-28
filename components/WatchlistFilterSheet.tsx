"use client";

import type { ReactNode } from "react";
import type { WatchlistFilters } from "@/lib/watchlistFilters";
import {
  DEFAULT_WATCHLIST_FILTERS,
  type WatchlistMarketFilter,
  type WatchlistPlatformFilter,
  type WatchlistSort,
} from "@/lib/watchlistFilters";

interface WatchlistFilterSheetProps {
  open: boolean;
  filters: WatchlistFilters;
  resultCount: number;
  onChange: (filters: WatchlistFilters) => void;
  onClose: () => void;
}

function FilterSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="mb-6">
      <h3 className="pulse-label mb-3 text-pulse-muted">{title}</h3>
      <div className="flex flex-wrap gap-2">{children}</div>
    </section>
  );
}

function FilterPill({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`pulse-chip ${active ? "pulse-chip-active" : "pulse-chip-inactive"}`}
    >
      {children}
    </button>
  );
}

const SORT_OPTIONS: { value: WatchlistSort; label: string }[] = [
  { value: "recently_active", label: "Recently active" },
  { value: "highest_win_rate", label: "Highest win rate" },
  { value: "most_open_positions", label: "Most open positions" },
  { value: "top_roi", label: "Top ROI" },
];

const MARKET_OPTIONS: { value: WatchlistMarketFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "SPORTS", label: "Sports" },
  { value: "POLITICS", label: "Politics" },
  { value: "CULTURE", label: "Culture" },
];

const PLATFORM_OPTIONS: { value: WatchlistPlatformFilter; label: string }[] = [
  { value: "all", label: "All books" },
  { value: "kalshi", label: "Kalshi" },
  { value: "polymarket", label: "Polymarket" },
];

export default function WatchlistFilterSheet({
  open,
  filters,
  resultCount,
  onChange,
  onClose,
}: WatchlistFilterSheetProps) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center">
      <button
        type="button"
        aria-label="Close filters"
        className="absolute inset-0 bg-black/70"
        onClick={onClose}
      />
      <div className="relative z-10 w-full max-w-md animate-slide-up rounded-t-2xl border border-pulse-border bg-pulse-card px-4 pb-6 pt-3 lg:max-w-lg">
        <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-pulse-border" />

        <div className="mb-6 flex items-center justify-between">
          <h2 className="text-lg font-bold text-white">Filter & sort</h2>
          <button
            type="button"
            onClick={() => onChange(DEFAULT_WATCHLIST_FILTERS)}
            className="text-sm font-semibold text-pulse-accent"
          >
            Reset
          </button>
        </div>

        <FilterSection title="Sort by">
          {SORT_OPTIONS.map((option) => (
            <FilterPill
              key={option.value}
              active={filters.sort === option.value}
              onClick={() => onChange({ ...filters, sort: option.value })}
            >
              {option.label}
            </FilterPill>
          ))}
        </FilterSection>

        <FilterSection title="Markets">
          {MARKET_OPTIONS.map((option) => (
            <FilterPill
              key={option.value}
              active={filters.market === option.value}
              onClick={() => onChange({ ...filters, market: option.value })}
            >
              {option.label}
            </FilterPill>
          ))}
        </FilterSection>

        <FilterSection title="Platform">
          {PLATFORM_OPTIONS.map((option) => (
            <FilterPill
              key={option.value}
              active={filters.platform === option.value}
              onClick={() => onChange({ ...filters, platform: option.value })}
            >
              {option.label}
            </FilterPill>
          ))}
        </FilterSection>

        <FilterSection title="Alerts">
          <FilterPill
            active={filters.alerts === "on"}
            onClick={() => onChange({ ...filters, alerts: "on" })}
          >
            On
          </FilterPill>
          <FilterPill
            active={filters.alerts === "off"}
            onClick={() => onChange({ ...filters, alerts: "off" })}
          >
            Off
          </FilterPill>
        </FilterSection>

        <div className="mb-6 flex items-center justify-between gap-4 rounded-pulse border border-pulse-border bg-pulse-surface px-4 py-3">
          <div>
            <p className="text-sm font-semibold text-white">
              Only whales with an open play
            </p>
            <p className="mt-0.5 text-xs text-pulse-muted">
              Hide whales with nothing live to tail
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={filters.onlyOpenPlay}
            onClick={() =>
              onChange({ ...filters, onlyOpenPlay: !filters.onlyOpenPlay })
            }
            className={`relative h-7 w-12 shrink-0 rounded-full transition-colors ${
              filters.onlyOpenPlay ? "bg-pulse-accent" : "bg-pulse-border"
            }`}
          >
            <span
              className={`absolute top-0.5 h-6 w-6 rounded-full bg-white transition-transform ${
                filters.onlyOpenPlay ? "translate-x-5" : "translate-x-0.5"
              }`}
            />
          </button>
        </div>

        <button type="button" onClick={onClose} className="pulse-btn-primary">
          Show {resultCount} whale{resultCount === 1 ? "" : "s"}
        </button>
      </div>
    </div>
  );
}
