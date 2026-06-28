"use client";

import Link from "next/link";
import {
  categoryBadgeClass,
  inferCategoryBadge,
} from "@/lib/marketCategory";
import {
  formatRoi,
  formatWinRate,
  type WatchlistProfile,
} from "@/lib/watchlistFilters";

function traderInitials(label: string, wallet: string): string {
  const fromLabel = label.replace(/[^a-zA-Z]/g, "").slice(0, 2).toUpperCase();
  if (fromLabel.length >= 2) return fromLabel;
  return wallet.slice(2, 4).toUpperCase();
}

function StatColumn({
  label,
  value,
  valueClass = "text-white",
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div className="text-center">
      <p className="pulse-label text-pulse-label">{label}</p>
      <p className={`mt-1 text-sm font-bold ${valueClass}`}>{value}</p>
    </div>
  );
}

export default function WatchlistTraderCard({ profile }: { profile: WatchlistProfile }) {
  const { trader, trackRecord, openPositions, openPositionCount, loading } =
    profile;
  const recentOpen = openPositions.slice(0, 4);
  const initials = traderInitials(trader.label, trader.wallet);

  return (
    <article className="pulse-card p-4">
      <Link
        href={`/traders/${encodeURIComponent(trader.wallet)}`}
        className="flex items-center gap-3"
      >
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-pulse-accent/20 text-xs font-bold text-pulse-accent">
          {initials}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-bold text-white">
            {trader.label}
          </p>
        </div>
        <span className="text-pulse-accent">→</span>
      </Link>

      <div className="mt-4 grid grid-cols-3 gap-2 rounded-lg bg-pulse-surface px-3 py-3">
        <StatColumn
          label="Open positions"
          value={loading ? "…" : String(openPositionCount)}
        />
        <StatColumn
          label="Win rate"
          value={loading ? "…" : formatWinRate(trackRecord?.winRate)}
          valueClass="text-pulse-yes"
        />
        <StatColumn
          label="ROI"
          value={loading ? "…" : formatRoi(trackRecord?.roi)}
          valueClass="text-pulse-yes"
        />
      </div>

      {recentOpen.length > 0 && (
        <div className="mt-4">
          <p className="pulse-label mb-2 text-pulse-label">
            Recent open positions
          </p>
          <ul className="space-y-2">
            {recentOpen.map((position) => {
              const badge = inferCategoryBadge(position.title);
              return (
                <li key={position.id} className="flex items-start gap-2">
                  <span
                    className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide ${categoryBadgeClass(badge.tone)}`}
                  >
                    {badge.label}
                  </span>
                  <p className="line-clamp-2 text-xs leading-snug text-white">
                    {position.title}
                  </p>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {!loading && openPositionCount === 0 && (
        <p className="mt-4 text-xs text-pulse-muted">
          No open positions right now
        </p>
      )}
    </article>
  );
}
