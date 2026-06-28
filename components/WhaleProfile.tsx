"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import MobileAppShell from "@/components/MobileAppShell";
import TraderIntelligenceCard from "@/components/TraderIntelligenceCard";
import {
  categoryBadgeClass,
  inferCategoryBadge,
} from "@/lib/marketCategory";
import { walletLabel } from "@/lib/bookmarkedTraders";
import { useBookmarkedTraders } from "@/lib/useBookmarkedTraders";
import type { CategoryStats } from "@/lib/polymarket";
import {
  formatTraderPnl,
  polymarketPositionUrl,
  TRADER_HISTORY_PAGE_SIZE,
  type TraderClosedPosition,
  type TraderOpenPosition,
} from "@/lib/traderProfile";
import { useWhaleTrackRecord } from "@/lib/useWhaleTrackRecord";

type ProfileTab = "positions" | "trades";

const PAGE_SIZE = 10;

const CATEGORY_META: Record<
  string,
  { icon: string; accent: string; label: string }
> = {
  Politics: { icon: "🏛", accent: "text-blue-400", label: "Politics" },
  Culture: { icon: "🎭", accent: "text-pulse-accent", label: "Culture" },
  Sports: { icon: "⚽", accent: "text-red-400", label: "Sports" },
  Crypto: { icon: "₿", accent: "text-amber-400", label: "Crypto" },
  Other: { icon: "📊", accent: "text-pulse-muted", label: "Other" },
};

function formatMoney(n: number): string {
  return `$${n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatCompactMoney(n: number): string {
  const sign = n >= 0 ? "+" : "-";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${Math.round(abs / 1_000)}K`;
  return formatTraderPnl(n);
}

function formatPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const sign = n >= 0 ? "+" : "";
  return `${sign}${Math.round(n)}%`;
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

function StatCard({
  label,
  value,
  sub,
  valueClass = "text-white",
}: {
  label: string;
  value: string;
  sub?: string;
  valueClass?: string;
}) {
  return (
    <div className="pulse-card flex-1 p-4">
      <div className="mb-3 flex items-start justify-between">
        <p className="pulse-label text-pulse-label">{label}</p>
        <span className="text-xs text-pulse-label">ⓘ</span>
      </div>
      <p className={`text-3xl font-bold ${valueClass}`}>{value}</p>
      {sub && (
        <p className="mt-1 text-[11px] font-semibold uppercase tracking-wide text-pulse-muted">
          {sub}
        </p>
      )}
    </div>
  );
}

function CategoryCard({
  stat,
  avgClv,
}: {
  stat: CategoryStats;
  avgClv: number | null;
}) {
  const meta = CATEGORY_META[stat.category] ?? CATEGORY_META.Other;
  const clvLabel =
    avgClv != null
      ? `${avgClv >= 0 ? "+" : ""}${(avgClv * 100).toFixed(1)}%`
      : "—";

  return (
    <div className="pulse-card p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-base">{meta.icon}</span>
          <span className={`text-sm font-bold ${meta.accent}`}>
            {meta.label}
          </span>
        </div>
        <span className="text-[10px] font-bold uppercase tracking-wide text-pulse-muted">
          {Math.round(stat.winRate)}% win rate
        </span>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <p className="pulse-label text-pulse-label">Net gain & loss</p>
          <p
            className={`mt-1 text-sm font-bold ${
              stat.pnl >= 0 ? "text-pulse-yes" : "text-pulse-no"
            }`}
          >
            {formatCompactMoney(stat.pnl)}
          </p>
        </div>
        <div>
          <p className="pulse-label text-pulse-label">Invested</p>
          <p className="mt-1 text-sm font-bold text-white">
            {formatCompactMoney(stat.staked)}
          </p>
        </div>
        <div>
          <p className="pulse-label text-pulse-label">ROI</p>
          <p
            className={`mt-1 text-sm font-bold ${
              stat.roi >= 0 ? "text-pulse-yes" : "text-pulse-no"
            }`}
          >
            {formatPct(stat.roi)}
          </p>
        </div>
        <div>
          <p className="pulse-label text-pulse-label">Avg. CLV</p>
          <p
            className={`mt-1 text-sm font-bold ${
              avgClv != null && avgClv >= 0
                ? "text-pulse-yes"
                : avgClv != null
                  ? "text-pulse-no"
                  : "text-pulse-muted"
            }`}
          >
            {clvLabel}
          </p>
        </div>
      </div>
    </div>
  );
}

function PositionRow({ position }: { position: TraderOpenPosition }) {
  const badge = inferCategoryBadge(position.title);
  const current = openCurrentValue(position);

  return (
    <tr className="border-b border-pulse-border/60 last:border-0">
      <td className="px-2 py-3 align-top">
        <a
          href={polymarketPositionUrl(position)}
          target="_blank"
          rel="noopener noreferrer"
          className="line-clamp-2 text-xs font-medium uppercase leading-snug text-white hover:text-pulse-accent"
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
      <td className="max-w-[4.5rem] truncate px-2 py-3 align-top text-xs uppercase text-pulse-muted">
        {position.outcome}
      </td>
      <td className="px-2 py-3 align-top text-xs font-bold text-pulse-yes">
        {formatCompactMoney(current)}
      </td>
      <td className="px-2 py-3 align-top text-xs font-bold text-pulse-yes">
        {formatCompactMoney(position.sizeUsd)}
      </td>
    </tr>
  );
}

function TradeRow({ position }: { position: TraderClosedPosition }) {
  const badge = inferCategoryBadge(position.title);

  return (
    <tr className="border-b border-pulse-border/60 last:border-0">
      <td className="px-2 py-3 align-top">
        <a
          href={polymarketPositionUrl(position)}
          target="_blank"
          rel="noopener noreferrer"
          className="line-clamp-2 text-xs font-medium uppercase leading-snug text-white hover:text-pulse-accent"
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
      <td className="max-w-[4.5rem] truncate px-2 py-3 align-top text-xs uppercase text-pulse-muted">
        {position.outcome}
      </td>
      <td className="px-2 py-3 align-top">
        <span
          className={`text-xs font-bold ${
            position.result === "won"
              ? "text-pulse-yes"
              : position.result === "lost"
                ? "text-pulse-no"
                : "text-pulse-muted"
          }`}
        >
          {position.result === "won"
            ? "Won"
            : position.result === "lost"
              ? "Lost"
              : "Even"}
        </span>
      </td>
      <td
        className={`px-2 py-3 align-top text-xs font-bold ${
          position.realizedPnl >= 0 ? "text-pulse-yes" : "text-pulse-no"
        }`}
      >
        {formatTraderPnl(position.realizedPnl)}
      </td>
    </tr>
  );
}

function ProfileSkeleton() {
  return (
    <div className="animate-pulse space-y-4 px-4 py-5">
      <div className="h-8 w-40 rounded bg-pulse-surface" />
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
  showIntelligence?: boolean;
}

export default function WhaleProfile({
  wallet,
  defaultTab = "positions",
  showIntelligence = false,
}: WhaleProfileProps) {
  const record = useWhaleTrackRecord(wallet);
  const { isBookmarked, toggle } = useBookmarkedTraders();
  const [tab, setTab] = useState<ProfileTab>(defaultTab);
  const [page, setPage] = useState(1);

  const displayName = walletLabel(wallet);
  const bookmarked = isBookmarked(wallet);

  const {
    data,
    trackRecord,
    loading,
    error,
    closedPositions,
    openPositions,
  } = record;

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

  const avgClv = data?.clvStats?.avgClv ?? null;

  const tabRows = tab === "positions" ? openPositions : closedPositions;
  const totalPages = Math.max(1, Math.ceil(tabRows.length / PAGE_SIZE));
  const pageRows = tabRows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

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
      <MobileAppShell>
        <ProfileSkeleton />
      </MobileAppShell>
    );
  }

  if (error) {
    return (
      <MobileAppShell>
        <main className="px-4 py-8">
          <p className="text-pulse-no">Could not load profile: {error}</p>
        </main>
      </MobileAppShell>
    );
  }

  return (
    <MobileAppShell>
      <main className="min-h-screen px-4 py-5">
        <Link
          href="/following"
          className="mb-4 inline-block text-sm text-pulse-muted hover:text-white"
        >
          ← Watchlist
        </Link>

        <header className="mb-5 flex items-start justify-between gap-3">
          <h1 className="text-2xl font-bold text-white">{displayName}</h1>
          <button
            type="button"
            onClick={() => void handleShare()}
            className="rounded-lg border border-pulse-border bg-pulse-card p-2 text-pulse-muted hover:text-white"
            aria-label="Share profile"
          >
            ↗
          </button>
        </header>

        <section className="mb-5">
          <p className="text-3xl font-bold tracking-tight text-white">
            {formatMoney(financials.netWorth)}
          </p>
          <GainLossBar
            gain={financials.totalGain}
            loss={financials.totalLoss}
          />
        </section>

        <button
          type="button"
          onClick={() => toggle({ wallet })}
          className={`mb-6 flex w-full items-center justify-center gap-2 rounded-pulse py-3.5 text-sm font-bold uppercase tracking-wide transition-colors ${
            bookmarked
              ? "border border-pulse-accent bg-pulse-accent/15 text-pulse-accent"
              : "bg-pulse-accent text-white hover:bg-pulse-accent-hover"
          }`}
        >
          {bookmarked ? "★ On watchlist" : "☆ Add to watchlist"}
        </button>

        {showIntelligence && <TraderIntelligenceCard wallet={wallet} />}

        <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <StatCard
            label="Win rate"
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
            valueClass="text-white"
          />
          <StatCard
            label="ROI"
            value={formatPct(trackRecord?.roi)}
            sub={
              trackRecord && trackRecord.closedCount > 0
                ? `On ${trackRecord.closedCount.toLocaleString()} plays`
                : undefined
            }
            valueClass="text-pulse-yes"
          />
          <StatCard
            label="Avg strategy EV"
            value={
              data?.pipelineEvAnalytics?.averageEvLabel ??
              data?.traderIntelligence?.averageStrategyEvLabel ??
              "—"
            }
            sub={
              data?.pipelineEvAnalytics?.tradeCount
                ? `${data.pipelineEvAnalytics.tradeCount} pipeline positions`
                : "AI pipeline · live"
            }
            valueClass={
              data?.pipelineEvAnalytics?.averageEv != null &&
              data.pipelineEvAnalytics.averageEv > 0
                ? "text-pulse-yes"
                : "text-white"
            }
          />
        </div>

        {categories.length > 0 && (
          <section className="mb-6 space-y-3">
            {categories.map((cat) => (
              <CategoryCard key={cat.category} stat={cat} avgClv={avgClv} />
            ))}
          </section>
        )}

        <div className="mb-4 flex items-center justify-between border-b border-pulse-border">
          <div className="flex gap-6">
            {(["positions", "trades"] as const).map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => {
                  setTab(key);
                  setPage(1);
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
            className="mb-2 flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-pulse-muted"
          >
            ↑↓ Filters / sort
          </button>
        </div>

        {tabRows.length === 0 ? (
          <div className="pulse-card px-4 py-10 text-center">
            <p className="text-sm text-pulse-muted">
              {tab === "positions"
                ? "No open positions right now"
                : "No closed trades to show yet"}
            </p>
          </div>
        ) : (
          <>
            <div className="overflow-x-auto rounded-pulse border border-pulse-border bg-pulse-card">
              <table className="min-w-full text-left">
                <thead>
                  <tr className="border-b border-pulse-border text-[9px] font-bold uppercase tracking-wide text-pulse-label">
                    {tab === "positions" ? (
                      <>
                        <th className="px-2 py-2.5">Event</th>
                        <th className="px-2 py-2.5">Market</th>
                        <th className="px-2 py-2.5">Position</th>
                        <th className="px-2 py-2.5">Current value</th>
                        <th className="px-2 py-2.5">Stake</th>
                      </>
                    ) : (
                      <>
                        <th className="px-2 py-2.5">Event</th>
                        <th className="px-2 py-2.5">Market</th>
                        <th className="px-2 py-2.5">Side</th>
                        <th className="px-2 py-2.5">Result</th>
                        <th className="px-2 py-2.5">P&L</th>
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
                {Math.min(page * PAGE_SIZE, tabRows.length)} of{" "}
                {tabRows.length} results
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  className="flex h-8 w-8 items-center justify-center rounded-lg border border-pulse-border bg-pulse-card text-pulse-accent disabled:opacity-30"
                >
                  ←
                </button>
                <button
                  type="button"
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  className="flex h-8 w-8 items-center justify-center rounded-lg border border-pulse-border bg-pulse-card text-pulse-accent disabled:opacity-30"
                >
                  →
                </button>
              </div>
            </div>
          </>
        )}

        {closedPositions.length > TRADER_HISTORY_PAGE_SIZE && tab === "trades" && (
          <p className="mt-4 text-center text-[10px] text-pulse-label">
            API returns up to {TRADER_HISTORY_PAGE_SIZE} recent closed positions
          </p>
        )}

        <p className="mt-6 break-all text-center font-mono text-[10px] text-pulse-label">
          {wallet}
        </p>
      </main>
    </MobileAppShell>
  );
}
