"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import MobileAppShell from "@/components/MobileAppShell";
import {
  categoryBadgeClass,
  inferCategoryBadge,
} from "@/lib/marketCategory";
import { useBookmarkedTraders } from "@/lib/useBookmarkedTraders";
import { isClvAverageEvComputable } from "@/lib/averageEvDisplay";
import type { CategoryStats } from "@/lib/polymarket";
import {
  generateDeterministicWhalePseudonym,
  isUsableCustomWhaleName,
  sanitizeWhaleDisplayName,
} from "@/lib/whaleIdentityResolver";
import {
  formatTraderPnl,
  polymarketPositionUrl,
  TRADER_HISTORY_PAGE_SIZE,
  type TraderClosedPosition,
  type TraderOpenPosition,
} from "@/lib/traderProfile";
import { useWhaleTrackRecord } from "@/lib/useWhaleTrackRecord";

type ProfileTab = "positions" | "trades";
type SortDir = "asc" | "desc";

type PositionSortKey =
  | "event"
  | "market"
  | "position"
  | "currentValue"
  | "stake";
type TradeSortKey = "time" | "side" | "market" | "outcome" | "value";
type SortKey = PositionSortKey | TradeSortKey;

const PAGE_SIZE = 10;

const CATEGORY_META: Record<
  string,
  { icon: string; pillClass: string; label: string }
> = {
  Politics: {
    icon: "🌐",
    pillClass: "bg-blue-500/20 text-blue-300",
    label: "Politics",
  },
  Culture: {
    icon: "🎬",
    pillClass: "bg-pulse-accent/20 text-pulse-accent",
    label: "Culture",
  },
  Sports: {
    icon: "⏱",
    pillClass: "bg-orange-500/20 text-orange-300",
    label: "Sports",
  },
  Crypto: {
    icon: "₿",
    pillClass: "bg-amber-500/20 text-amber-300",
    label: "Crypto",
  },
  Other: {
    icon: "📊",
    pillClass: "bg-pulse-surface text-pulse-muted",
    label: "Other",
  },
};

const WHALE_METRIC_TOOLTIPS = {
  winRate:
    "How often this whale's bets win. 68% means roughly 7 of 10 have hit.",
  roi: "For every dollar this whale bet, how much they made or lost overall.",
  avgClv:
    "How consistently this bettor got better prices than where the market ended up.",
} as const;

function formatMoney(n: number): string {
  return `$${n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatCompactMoney(n: number, signed = true): string {
  const sign = signed ? (n >= 0 ? "+" : "-") : "";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${Math.round(abs / 1_000)}K`;
  return signed ? formatTraderPnl(n) : `$${abs.toFixed(0)}`;
}

function formatPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const sign = n >= 0 ? "+" : "";
  return `${sign}${Math.round(n)}%`;
}

function formatClvPct(clv: number | null | undefined): string {
  if (clv == null || !Number.isFinite(clv)) return "—";
  const pct = clv * 100;
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}

function formatTradeTime(ts: number | null): string {
  if (ts == null) return "—";
  const date = new Date(ts * 1000);
  const now = new Date();
  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (isToday) {
    return date.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
  }
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function openCurrentValue(position: TraderOpenPosition): number {
  if (position.avgPrice > 0) {
    const contracts = position.sizeUsd / position.avgPrice;
    return contracts * position.currentPrice;
  }
  return position.sizeUsd + position.unrealizedPnl;
}

function closedWinsLosses(
  wins: number,
  closedCount: number
): { wins: number; losses: number } {
  return { wins, losses: Math.max(0, closedCount - wins) };
}

function resolveDisplayName(
  wallet: string,
  bookmarkLabel?: string
): string {
  if (bookmarkLabel && isUsableCustomWhaleName(bookmarkLabel, wallet)) {
    return bookmarkLabel.trim();
  }
  return sanitizeWhaleDisplayName(
    generateDeterministicWhalePseudonym(wallet),
    wallet
  );
}

function outcomePillClass(outcome: string): string {
  const normalized = outcome.trim().toLowerCase();
  if (normalized === "yes") return "bg-blue-500/20 text-blue-300";
  if (normalized === "no") return "bg-red-500/20 text-red-300";
  return "bg-pulse-surface text-pulse-muted";
}

function sidePillClass(side: string): string {
  if (side === "BUY") return "bg-pulse-yes/15 text-pulse-yes";
  if (side === "SELL") return "bg-purple-500/20 text-purple-300";
  return "bg-amber-500/20 text-amber-300";
}

function inferTradeSide(position: TraderClosedPosition): "BUY" | "SELL" | "HOLD" {
  if (position.realizedPnl > 0 && position.result === "won") return "BUY";
  if (position.realizedPnl < 0 && position.result === "lost") return "SELL";
  return "HOLD";
}

function GainLossBar({
  gain,
  loss,
}: {
  gain: number;
  loss: number;
}) {
  const total = gain + loss;
  const gainPct = total > 0 ? (gain / total) * 100 : 50;

  return (
    <div className="mt-3">
      <div className="mb-2 flex justify-between text-[11px] font-bold uppercase tracking-wide">
        <span className="text-pulse-yes">{formatCompactMoney(gain)} Gain</span>
        <span className="text-pulse-no">{formatCompactMoney(-loss)} Loss</span>
      </div>
      <div className="flex h-2 overflow-hidden rounded-full bg-pulse-surface">
        <div
          className="bg-pulse-yes transition-all"
          style={{ width: `${gainPct}%` }}
        />
        <div
          className="bg-pulse-no transition-all"
          style={{ width: `${100 - gainPct}%` }}
        />
      </div>
    </div>
  );
}

function MetricInfoButton({
  label,
  tooltip,
}: {
  label: string;
  tooltip: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative">
      <button
        type="button"
        aria-label={`${label}: ${tooltip}`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex h-4 w-4 items-center justify-center rounded-full bg-pulse-accent/20 text-[10px] font-bold text-pulse-accent"
      >
        i
      </button>
      {open ? (
        <span className="absolute right-0 top-5 z-20 w-44 rounded-lg border border-pulse-border bg-black px-2 py-2 text-[10px] leading-relaxed text-pulse-muted shadow-lg">
          {tooltip}
        </span>
      ) : null}
    </span>
  );
}

function StatCard({
  label,
  value,
  sub,
  valueClass = "text-white",
  tooltipKey,
}: {
  label: string;
  value: string;
  sub?: string;
  valueClass?: string;
  tooltipKey: keyof typeof WHALE_METRIC_TOOLTIPS;
}) {
  return (
    <div className="flex-1 rounded-2xl border border-pulse-border bg-pulse-card p-4">
      <div className="mb-3 flex items-start justify-between">
        <p className="text-[10px] font-bold uppercase tracking-wide text-pulse-label">
          {label}
        </p>
        <MetricInfoButton
          label={label}
          tooltip={WHALE_METRIC_TOOLTIPS[tooltipKey]}
        />
      </div>
      <p className={`text-3xl font-bold ${valueClass}`}>{value}</p>
      {sub ? (
        <p className="mt-1 text-[11px] font-semibold uppercase tracking-wide text-pulse-muted">
          {sub}
        </p>
      ) : null}
    </div>
  );
}

function CategoryCard({
  stat,
  showClv,
  avgClv,
}: {
  stat: CategoryStats;
  showClv: boolean;
  avgClv: number | null;
}) {
  const meta = CATEGORY_META[stat.category] ?? CATEGORY_META.Other;

  return (
    <div className="rounded-2xl border border-pulse-border bg-pulse-card p-4">
      <div className="mb-4 flex items-center justify-between gap-2">
        <span
          className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide ${meta.pillClass}`}
        >
          <span aria-hidden>{meta.icon}</span>
          {meta.label}
        </span>
        <span className="text-[10px] font-bold uppercase tracking-wide text-pulse-yes">
          {Math.round(stat.winRate)}% Win Rate
        </span>
      </div>
      <div className={`grid gap-3 ${showClv ? "grid-cols-2" : "grid-cols-3"}`}>
        <div>
          <p className="text-[10px] font-bold uppercase tracking-wide text-pulse-label">
            Net Gain & Loss
          </p>
          <p
            className={`mt-1 text-sm font-bold ${
              stat.pnl >= 0 ? "text-pulse-yes" : "text-pulse-no"
            }`}
          >
            {formatCompactMoney(stat.pnl)}
          </p>
        </div>
        <div>
          <p className="text-[10px] font-bold uppercase tracking-wide text-pulse-label">
            Invested
          </p>
          <p className="mt-1 text-sm font-bold text-white">
            {formatCompactMoney(stat.staked, false)}
          </p>
        </div>
        <div>
          <p className="text-[10px] font-bold uppercase tracking-wide text-pulse-label">
            ROI
          </p>
          <p
            className={`mt-1 text-sm font-bold ${
              stat.roi >= 0 ? "text-pulse-yes" : "text-pulse-no"
            }`}
          >
            {formatPct(stat.roi)}
          </p>
        </div>
        {showClv ? (
          <div>
            <div className="flex items-center gap-1">
              <p className="text-[10px] font-bold uppercase tracking-wide text-pulse-label">
                Avg. CLV
              </p>
              <MetricInfoButton
                label="Avg. CLV"
                tooltip={WHALE_METRIC_TOOLTIPS.avgClv}
              />
            </div>
            <p
              className={`mt-1 text-sm font-bold ${
                avgClv != null && avgClv >= 0
                  ? "text-pulse-yes"
                  : avgClv != null
                    ? "text-pulse-no"
                    : "text-pulse-muted"
              }`}
            >
              {formatClvPct(avgClv)}
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function SortHeader({
  label,
  active,
  direction,
  onClick,
}: {
  label: string;
  active: boolean;
  direction: SortDir;
  onClick: () => void;
}) {
  return (
    <th className="px-2 py-2.5">
      <button
        type="button"
        onClick={onClick}
        className={`flex items-center gap-0.5 text-[9px] font-bold uppercase tracking-wide ${
          active ? "text-white" : "text-pulse-label"
        }`}
      >
        {label}
        <span className="text-[8px] text-pulse-accent" aria-hidden>
          {active ? (direction === "asc" ? "↑" : "↓") : "↕"}
        </span>
      </button>
    </th>
  );
}

function PositionRow({ position }: { position: TraderOpenPosition }) {
  const badge = inferCategoryBadge(position.title);
  const current = openCurrentValue(position);

  return (
    <tr className="border-b border-pulse-border/60 last:border-0">
      <td className="max-w-[7rem] px-2 py-3 align-top">
        <a
          href={polymarketPositionUrl(position)}
          target="_blank"
          rel="noopener noreferrer"
          className="line-clamp-2 text-[10px] font-medium uppercase leading-snug text-white hover:text-pulse-accent"
        >
          {position.title}
        </a>
      </td>
      <td className="px-2 py-3 align-top">
        <span
          className={`inline-block rounded px-1.5 py-0.5 text-[9px] font-bold uppercase ${categoryBadgeClass(badge.tone)}`}
        >
          {badge.label}
        </span>
      </td>
      <td className="max-w-[4rem] truncate px-2 py-3 align-top text-[10px] font-semibold uppercase text-pulse-muted">
        {position.outcome}
      </td>
      <td className="px-2 py-3 align-top text-[10px] font-bold text-pulse-yes">
        {formatCompactMoney(current, false)}
      </td>
      <td className="px-2 py-3 align-top text-[10px] font-bold text-pulse-yes">
        {formatCompactMoney(position.sizeUsd, false)}
      </td>
    </tr>
  );
}

function TradeRow({ position }: { position: TraderClosedPosition }) {
  const badge = inferCategoryBadge(position.title);
  const side = inferTradeSide(position);

  return (
    <tr className="border-b border-pulse-border/60 last:border-0">
      <td className="px-2 py-3 align-top text-[10px] font-medium text-pulse-muted">
        {formatTradeTime(position.resolvedAt)}
      </td>
      <td className="px-2 py-3 align-top">
        <span
          className={`inline-block rounded px-1.5 py-0.5 text-[9px] font-bold uppercase ${sidePillClass(side)}`}
        >
          {side}
        </span>
      </td>
      <td className="px-2 py-3 align-top">
        <span
          className={`inline-block rounded px-1.5 py-0.5 text-[9px] font-bold uppercase ${categoryBadgeClass(badge.tone)}`}
        >
          {badge.label}
        </span>
      </td>
      <td className="px-2 py-3 align-top">
        <span
          className={`inline-block rounded px-1.5 py-0.5 text-[9px] font-bold uppercase ${outcomePillClass(position.outcome)}`}
        >
          {position.outcome}
        </span>
      </td>
      <td className="px-2 py-3 align-top text-[10px] font-bold text-pulse-yes">
        {formatCompactMoney(position.sizeUsd, false)}
      </td>
    </tr>
  );
}

function ProfileSkeleton() {
  return (
    <div className="animate-pulse space-y-4 px-4 py-5">
      <div className="h-8 w-full rounded bg-pulse-surface" />
      <div className="h-12 w-full rounded bg-pulse-surface" />
      <div className="h-10 w-full rounded bg-pulse-surface" />
      <div className="flex gap-3">
        <div className="h-28 flex-1 rounded bg-pulse-surface" />
        <div className="h-28 flex-1 rounded bg-pulse-surface" />
      </div>
    </div>
  );
}

interface WhaleProfileProps {
  wallet: string;
  defaultTab?: ProfileTab;
}

export default function WhaleProfile({
  wallet,
  defaultTab = "positions",
}: WhaleProfileProps) {
  const router = useRouter();
  const record = useWhaleTrackRecord(wallet);
  const { isBookmarked, toggle, bookmarks } = useBookmarkedTraders();
  const [tab, setTab] = useState<ProfileTab>(defaultTab);
  const [page, setPage] = useState(1);
  const [sortKey, setSortKey] = useState<SortKey>(
    defaultTab === "trades" ? "time" : "currentValue"
  );
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [filterOpen, setFilterOpen] = useState(false);
  const [marketFilter, setMarketFilter] = useState<string | null>(null);

  const bookmark = bookmarks.find((b) => b.wallet === wallet.toLowerCase());
  const displayName = resolveDisplayName(wallet, bookmark?.label);
  const bookmarked = isBookmarked(wallet);

  const {
    data,
    trackRecord,
    loading,
    error,
    closedPositions,
    openPositions,
  } = record;

  const showClv = isClvAverageEvComputable(data?.clvStats);
  const avgClv = data?.clvStats?.avgClv ?? null;

  const financials = useMemo(() => {
    let totalGain = 0;
    let totalLoss = 0;
    for (const p of closedPositions) {
      if (p.realizedPnl > 0) totalGain += p.realizedPnl;
      else if (p.realizedPnl < 0) totalLoss += Math.abs(p.realizedPnl);
    }

    const openValue = openPositions.reduce(
      (sum, p) => sum + openCurrentValue(p),
      0
    );
    const invested = trackRecord?.totalInvested ?? 0;
    const realized = trackRecord?.totalRealizedPnl ?? 0;
    const netWorth = openValue + invested + realized;

    return { totalGain, totalLoss, netWorth, openValue };
  }, [closedPositions, openPositions, trackRecord]);

  const { wins, losses } = useMemo(() => {
    const closedCount = trackRecord?.closedCount ?? 0;
    const winCount =
      trackRecord?.closedWins ??
      (trackRecord?.winRate != null && closedCount > 0
        ? Math.round((trackRecord.winRate / 100) * closedCount)
        : 0);
    return closedWinsLosses(winCount, closedCount);
  }, [trackRecord]);

  const categories = useMemo(() => {
    const stats = data?.categoryStats ?? [];
    const preferred = ["Politics", "Culture", "Sports"];
    const ordered = [
      ...preferred
        .map((name) => stats.find((s) => s.category === name))
        .filter(Boolean),
      ...stats.filter((s) => !preferred.includes(s.category)),
    ] as CategoryStats[];
    return ordered.slice(0, 3);
  }, [data?.categoryStats]);

  const marketFilterOptions = useMemo(() => {
    const rows = tab === "positions" ? openPositions : closedPositions;
    const labels = new Set<string>();
    for (const row of rows) {
      labels.add(inferCategoryBadge(row.title).label);
    }
    return Array.from(labels).sort();
  }, [tab, openPositions, closedPositions]);

  const sortedRows = useMemo(() => {
    const rows =
      tab === "positions"
        ? [...openPositions]
        : [...closedPositions];

    const filtered = marketFilter
      ? rows.filter(
          (row) => inferCategoryBadge(row.title).label === marketFilter
        )
      : rows;

    const dir = sortDir === "asc" ? 1 : -1;

    filtered.sort((a, b) => {
      if (tab === "positions") {
        const pa = a as TraderOpenPosition;
        const pb = b as TraderOpenPosition;
        switch (sortKey as PositionSortKey) {
          case "event":
            return pa.title.localeCompare(pb.title) * dir;
          case "market":
            return inferCategoryBadge(pa.title).label.localeCompare(
              inferCategoryBadge(pb.title).label
            ) * dir;
          case "position":
            return pa.outcome.localeCompare(pb.outcome) * dir;
          case "currentValue":
            return (openCurrentValue(pa) - openCurrentValue(pb)) * dir;
          case "stake":
          default:
            return (pa.sizeUsd - pb.sizeUsd) * dir;
        }
      }

      const ta = a as TraderClosedPosition;
      const tb = b as TraderClosedPosition;
      switch (sortKey as TradeSortKey) {
        case "time":
          return ((ta.resolvedAt ?? 0) - (tb.resolvedAt ?? 0)) * dir;
        case "side":
          return inferTradeSide(ta).localeCompare(inferTradeSide(tb)) * dir;
        case "market":
          return inferCategoryBadge(ta.title).label.localeCompare(
            inferCategoryBadge(tb.title).label
          ) * dir;
        case "outcome":
          return ta.outcome.localeCompare(tb.outcome) * dir;
        case "value":
        default:
          return (ta.sizeUsd - tb.sizeUsd) * dir;
      }
    });

    return filtered;
  }, [
    tab,
    openPositions,
    closedPositions,
    marketFilter,
    sortKey,
    sortDir,
  ]);

  const totalPages = Math.max(1, Math.ceil(sortedRows.length / PAGE_SIZE));
  const pageRows = sortedRows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
    setPage(1);
  };

  const handleShare = async () => {
    const url = window.location.href;
    if (navigator.share) {
      try {
        await navigator.share({ title: displayName, url });
        return;
      } catch {
        // fall through
      }
    }
    await navigator.clipboard.writeText(url);
  };

  if (loading && !trackRecord) {
    return (
      <MobileAppShell showNav={false}>
        <ProfileSkeleton />
      </MobileAppShell>
    );
  }

  if (error) {
    return (
      <MobileAppShell showNav={false}>
        <main className="px-4 py-8">
          <p className="text-pulse-no">Could not load profile: {error}</p>
        </main>
      </MobileAppShell>
    );
  }

  return (
    <MobileAppShell showNav={false}>
      <main className="min-h-screen px-4 pb-8 pt-4">
        <header className="relative mb-6 flex items-center">
          <button
            type="button"
            onClick={() => router.back()}
            className="absolute left-0 text-pulse-muted transition-colors hover:text-white"
            aria-label="Go back"
          >
            ←
          </button>
          <h1 className="flex-1 truncate px-10 text-center text-lg font-bold text-white">
            {displayName}
          </h1>
          <button
            type="button"
            onClick={() => void handleShare()}
            className="absolute right-0 flex h-8 w-8 items-center justify-center rounded-lg border border-pulse-accent/40 text-pulse-accent"
            aria-label="Share profile"
          >
            ↗
          </button>
        </header>

        <section className="mb-5">
          <div className="flex items-end justify-between gap-3">
            <p className="text-3xl font-bold tracking-tight text-white">
              {formatMoney(financials.netWorth)}
            </p>
            <p className="pb-1 text-[10px] font-bold uppercase tracking-wide text-pulse-label">
              Total Gain & Loss
            </p>
          </div>
          <GainLossBar
            gain={financials.totalGain}
            loss={financials.totalLoss}
          />
        </section>

        <button
          type="button"
          onClick={() =>
            toggle({
              wallet,
              label: displayName,
            })
          }
          className={`mb-6 flex w-full items-center justify-center gap-2 rounded-xl py-3.5 text-sm font-bold uppercase tracking-wide transition-colors ${
            bookmarked
              ? "border border-pulse-accent bg-pulse-accent/15 text-pulse-accent"
              : "bg-pulse-accent text-black hover:bg-pulse-accent/90"
          }`}
        >
          {bookmarked ? "★ On Watchlist" : "🔔 Add to Watchlist"}
        </button>

        <div className="mb-6 flex gap-3">
          <StatCard
            label="Win Rate"
            value={
              trackRecord?.winRate != null
                ? `${Math.round(trackRecord.winRate)}%`
                : "—"
            }
            sub={
              wins + losses > 0
                ? `${wins.toLocaleString()} W · ${losses.toLocaleString()} L`
                : undefined
            }
            valueClass={
              trackRecord?.winRate != null && trackRecord.winRate >= 55
                ? "text-pulse-yes"
                : "text-white"
            }
            tooltipKey="winRate"
          />
          <StatCard
            label="ROI"
            value={formatPct(trackRecord?.roi)}
            sub={
              trackRecord && trackRecord.closedCount > 0
                ? `On ${trackRecord.closedCount.toLocaleString()} plays`
                : undefined
            }
            valueClass={
              trackRecord?.roi != null && trackRecord.roi >= 0
                ? "text-pulse-yes"
                : trackRecord?.roi != null
                  ? "text-pulse-no"
                  : "text-white"
            }
            tooltipKey="roi"
          />
        </div>

        {categories.length > 0 ? (
          <section className="mb-6 space-y-3">
            {categories.map((cat) => (
              <CategoryCard
                key={cat.category}
                stat={cat}
                showClv={showClv}
                avgClv={avgClv}
              />
            ))}
          </section>
        ) : null}

        <div className="mb-3 flex items-center justify-between border-b border-pulse-border">
          <div className="flex gap-6">
            {(["positions", "trades"] as const).map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => {
                  setTab(key);
                  setPage(1);
                  setSortKey(key === "trades" ? "time" : "currentValue");
                  setSortDir("desc");
                  setMarketFilter(null);
                }}
                className={`pb-3 text-sm font-bold uppercase tracking-wide transition-colors ${
                  tab === key
                    ? "border-b-2 border-pulse-accent text-white"
                    : "text-pulse-muted hover:text-white"
                }`}
              >
                {key === "positions" ? "Positions" : "Trades"}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setFilterOpen((v) => !v)}
            className={`mb-2 flex items-center gap-1 rounded-lg border px-2 py-1 text-[10px] font-bold uppercase tracking-wide transition-colors ${
              filterOpen || marketFilter
                ? "border-pulse-accent text-pulse-accent"
                : "border-pulse-border text-pulse-muted"
            }`}
          >
            ⇅ Filters / Sort
          </button>
        </div>

        {filterOpen ? (
          <div className="mb-4 rounded-xl border border-pulse-border bg-pulse-card p-3">
            <p className="mb-2 text-[10px] font-bold uppercase tracking-wide text-pulse-label">
              Filter by market
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => {
                  setMarketFilter(null);
                  setPage(1);
                }}
                className={`rounded-full px-2.5 py-1 text-[10px] font-bold uppercase ${
                  marketFilter == null
                    ? "bg-pulse-accent text-black"
                    : "bg-pulse-surface text-pulse-muted"
                }`}
              >
                All
              </button>
              {marketFilterOptions.map((label) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => {
                    setMarketFilter(label);
                    setPage(1);
                  }}
                  className={`rounded-full px-2.5 py-1 text-[10px] font-bold uppercase ${
                    marketFilter === label
                      ? "bg-pulse-accent text-black"
                      : "bg-pulse-surface text-pulse-muted"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {sortedRows.length === 0 ? (
          <div className="rounded-2xl border border-pulse-border bg-pulse-card px-4 py-10 text-center">
            <p className="text-sm text-pulse-muted">
              {tab === "positions"
                ? "No open positions right now"
                : "No closed trades to show yet"}
            </p>
          </div>
        ) : (
          <>
            <div className="overflow-x-auto rounded-2xl border border-pulse-border bg-pulse-card">
              <table className="min-w-full text-left">
                <thead>
                  <tr className="border-b border-pulse-border">
                    {tab === "positions" ? (
                      <>
                        <SortHeader
                          label="Event"
                          active={sortKey === "event"}
                          direction={sortDir}
                          onClick={() => toggleSort("event")}
                        />
                        <SortHeader
                          label="Market"
                          active={sortKey === "market"}
                          direction={sortDir}
                          onClick={() => toggleSort("market")}
                        />
                        <SortHeader
                          label="Position"
                          active={sortKey === "position"}
                          direction={sortDir}
                          onClick={() => toggleSort("position")}
                        />
                        <SortHeader
                          label="Current Value"
                          active={sortKey === "currentValue"}
                          direction={sortDir}
                          onClick={() => toggleSort("currentValue")}
                        />
                        <SortHeader
                          label="Stake"
                          active={sortKey === "stake"}
                          direction={sortDir}
                          onClick={() => toggleSort("stake")}
                        />
                      </>
                    ) : (
                      <>
                        <SortHeader
                          label="Time"
                          active={sortKey === "time"}
                          direction={sortDir}
                          onClick={() => toggleSort("time")}
                        />
                        <SortHeader
                          label="Side"
                          active={sortKey === "side"}
                          direction={sortDir}
                          onClick={() => toggleSort("side")}
                        />
                        <SortHeader
                          label="Market"
                          active={sortKey === "market"}
                          direction={sortDir}
                          onClick={() => toggleSort("market")}
                        />
                        <SortHeader
                          label="Outcome"
                          active={sortKey === "outcome"}
                          direction={sortDir}
                          onClick={() => toggleSort("outcome")}
                        />
                        <SortHeader
                          label="Value"
                          active={sortKey === "value"}
                          direction={sortDir}
                          onClick={() => toggleSort("value")}
                        />
                      </>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {tab === "positions"
                    ? (pageRows as TraderOpenPosition[]).map((row) => (
                        <PositionRow key={row.id} position={row} />
                      ))
                    : (pageRows as TraderClosedPosition[]).map((row) => (
                        <TradeRow key={row.id} position={row} />
                      ))}
                </tbody>
              </table>
            </div>

            <div className="mt-4 flex items-center justify-between">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-pulse-label">
                Showing {(page - 1) * PAGE_SIZE + 1} to{" "}
                {Math.min(page * PAGE_SIZE, sortedRows.length)} of{" "}
                {sortedRows.length.toLocaleString()} results
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  className="flex h-8 w-8 items-center justify-center rounded-lg border border-pulse-border bg-pulse-card text-pulse-accent disabled:opacity-30"
                  aria-label="Previous page"
                >
                  ←
                </button>
                <button
                  type="button"
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  className="flex h-8 w-8 items-center justify-center rounded-lg border border-pulse-border bg-pulse-card text-pulse-accent disabled:opacity-30"
                  aria-label="Next page"
                >
                  →
                </button>
              </div>
            </div>
          </>
        )}

        {closedPositions.length > TRADER_HISTORY_PAGE_SIZE && tab === "trades" ? (
          <p className="mt-4 text-center text-[10px] text-pulse-label">
            API returns up to {TRADER_HISTORY_PAGE_SIZE} recent closed positions
          </p>
        ) : null}
      </main>
    </MobileAppShell>
  );
}
