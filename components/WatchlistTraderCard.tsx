"use client";

import Link from "next/link";
import {
  categoryBadgeClass,
  inferCategoryBadge,
} from "@/lib/marketCategory";
import {
  formatRoi,
  formatWinRate,
  roiColorClass,
  type WatchlistProfile,
} from "@/lib/watchlistFilters";
import {
  isUsableCustomWhaleName,
  sanitizeWhaleDisplayName,
  generateDeterministicWhalePseudonym,
} from "@/lib/whaleIdentityResolver";

function traderInitials(label: string, wallet: string): string {
  const fromLabel = label.replace(/[^a-zA-Z]/g, "").slice(0, 2).toUpperCase();
  if (fromLabel.length >= 2) return fromLabel;
  return wallet.slice(2, 4).toUpperCase();
}

function displayName(trader: WatchlistProfile["trader"]): string {
  if (isUsableCustomWhaleName(trader.label, trader.wallet)) {
    return trader.label.trim();
  }
  return sanitizeWhaleDisplayName(
    generateDeterministicWhalePseudonym(trader.wallet),
    trader.wallet
  );
}

function StatCell({
  label,
  value,
  valueClass = "text-white",
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div className="rounded-xl border border-pulse-border bg-pulse-surface/60 px-2 py-3 text-center">
      <p className="text-[9px] font-bold uppercase tracking-wide text-pulse-label">
        {label}
      </p>
      <p className={`mt-1.5 text-lg font-bold ${valueClass}`}>{value}</p>
    </div>
  );
}

export default function WatchlistTraderCard({
  profile,
}: {
  profile: WatchlistProfile;
}) {
  const { trader, trackRecord, openPositions, openPositionCount, loading } =
    profile;
  const recentOpen = openPositions.slice(0, 3);
  const name = displayName(trader);
  const initials = traderInitials(name, trader.wallet);
  const roi = trackRecord?.roi ?? null;

  return (
    <article className="rounded-2xl border border-pulse-border bg-pulse-card p-4">
      <Link
        href={`/traders/${encodeURIComponent(trader.wallet)}`}
        className="flex items-center gap-3"
      >
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-pulse-accent/20 text-xs font-bold text-pulse-accent">
          {initials}
        </div>
        <p className="min-w-0 flex-1 truncate text-sm font-bold text-white">
          {name}
        </p>
        <span className="text-pulse-accent" aria-hidden>
          ›
        </span>
      </Link>

      <div className="mt-4 grid grid-cols-3 gap-2">
        <StatCell
          label="Open Positions"
          value={loading ? "…" : String(openPositionCount)}
        />
        <StatCell
          label="Win Rate"
          value={loading ? "…" : formatWinRate(trackRecord?.winRate)}
          valueClass="text-pulse-yes"
        />
        <StatCell
          label="ROI"
          value={loading ? "…" : formatRoi(roi)}
          valueClass={roiColorClass(roi)}
        />
      </div>

      {recentOpen.length > 0 ? (
        <div className="mt-4">
          <p className="mb-2 text-[10px] font-bold uppercase tracking-wide text-pulse-label">
            Recent Open Positions
          </p>
          <ul className="space-y-2.5">
            {recentOpen.map((position) => {
              const badge = inferCategoryBadge(position.title);
              return (
                <li key={position.id} className="flex items-start gap-2">
                  <span
                    className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide ${categoryBadgeClass(badge.tone)}`}
                  >
                    {badge.label}
                  </span>
                  <p className="line-clamp-2 text-[11px] font-medium uppercase leading-snug text-white">
                    {position.title}
                  </p>
                </li>
              );
            })}
          </ul>
        </div>
      ) : !loading ? (
        <p className="mt-4 text-xs text-pulse-muted">No open positions right now</p>
      ) : null}
    </article>
  );
}
