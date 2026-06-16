"use client";

import { useEffect, useRef, useState } from "react";
import type { CategoryStats, ClvStats, TrackRecord } from "@/lib/polymarket";
import CategoryRoiBreakdown from "@/components/CategoryRoiBreakdown";
import ClvCard from "@/components/ClvCard";

interface WhaleTrackRecordProps {
  proxyWallet?: string;
  walletUnavailable?: boolean;
  entryPrice: number;
  currentPrice: number | null;
  betSize: number;
}

interface TrackRecordResponse {
  wallet: string | null;
  trackRecord: TrackRecord | null;
  openPositionCount: number;
  categoryStats?: CategoryStats[];
  clvStats?: ClvStats | null;
  resolved: boolean;
  cached?: boolean;
  error?: string;
}

function formatDollars(n: number): string {
  if (n >= 1000000) return `$${(n / 1000000).toFixed(2)}M`;
  if (n >= 1000)
    return `$${n.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  return `$${n.toFixed(2)}`;
}

function formatCents(price: number): string {
  return `${(price * 100).toFixed(1)}¢`;
}

function formatWinRate(rate: number | null): string {
  if (rate === null) return "—";
  return `${Math.round(rate)}%`;
}

function formatAvgReturn(avg: number | null): string {
  if (avg === null) return "—";
  const sign = avg >= 0 ? "+" : "";
  return `${sign}${formatDollars(avg)}`;
}

function formatRoiPct(roi: number | null): string {
  if (roi === null) return "—";
  const sign = roi >= 0 ? "+" : "";
  return `${sign}${roi.toFixed(1)}%`;
}

function winRateColor(rate: number | null): string {
  if (rate === null) return "text-white";
  if (rate >= 60) return "text-pulse-yes";
  if (rate >= 45) return "text-yellow-400";
  return "text-red-400";
}

function avgReturnColor(avg: number | null): string {
  if (avg === null) return "text-white";
  return avg >= 0 ? "text-pulse-yes" : "text-red-400";
}

function roiColor(roi: number | null): string {
  if (roi === null) return "text-white";
  if (roi >= 5) return "text-pulse-yes";
  if (roi >= 0) return "text-amber-400";
  return "text-red-400";
}

function MetricBox({
  value,
  label,
  explain,
  valueClassName = "text-white",
  badge,
  emptyValue = false,
}: {
  value: string;
  label: string;
  explain: string;
  valueClassName?: string;
  badge?: string;
  emptyValue?: boolean;
}) {
  return (
    <div className="rounded-xl border border-slate-700 bg-slate-900/50 p-4">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <p
          className={`font-bold ${
            emptyValue ? "text-lg text-slate-500" : "text-xl"
          } ${emptyValue ? "" : valueClassName}`}
        >
          {value}
        </p>
        {badge && (
          <span className="rounded-full bg-slate-700/60 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-400">
            {badge}
          </span>
        )}
      </div>
      <p className="mb-2 text-xs font-medium text-slate-300">{label}</p>
      <p className="text-xs leading-relaxed text-slate-400">{explain}</p>
    </div>
  );
}

function SkeletonBox() {
  return (
    <div className="rounded-xl border border-slate-700 bg-slate-900/50 p-4 animate-pulse">
      <div className="mb-2 h-7 w-16 rounded bg-slate-700" />
      <div className="mb-2 h-3 w-24 rounded bg-slate-700" />
      <div className="h-8 w-full rounded bg-slate-700/60" />
    </div>
  );
}

export default function WhaleTrackRecord({
  proxyWallet,
  walletUnavailable = false,
  entryPrice,
  currentPrice,
  betSize,
}: WhaleTrackRecordProps) {
  const [data, setData] = useState<TrackRecordResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);

  useEffect(() => {
    if (!proxyWallet) {
      setData(null);
      setLoading(false);
      setError(null);
      return;
    }

    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    setData(null);

    const load = async () => {
      try {
        const res = await fetch(
          `/api/whale-track-record?wallet=${encodeURIComponent(proxyWallet)}`
        );
        if (id !== requestId.current) return;

        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }

        const result: TrackRecordResponse = await res.json();
        if (id !== requestId.current) return;

        setData((prev) => {
          if (prev?.resolved && prev.trackRecord && !result.trackRecord) {
            return prev;
          }
          return result;
        });
      } catch (err) {
        if (id !== requestId.current) return;
        setError(
          err instanceof Error ? err.message : "Failed to load track record"
        );
      } finally {
        if (id === requestId.current) {
          setLoading(false);
        }
      }
    };

    void load();
  }, [proxyWallet]);

  const trackRecord = data?.trackRecord;
  const waitingForWallet = !proxyWallet && !walletUnavailable;
  const loadingRecord = !!proxyWallet && loading && !trackRecord;
  const hasEnoughHistory = trackRecord?.hasEnoughHistory ?? false;
  const closedCount = trackRecord?.closedCount ?? 0;
  const openPositionCount = data?.openPositionCount ?? 0;
  const noClosedHistory = closedCount === 0;
  const emptyMetricBadge =
    openPositionCount > 0 ? "Open bets only" : "New wallet";
  const roi: number | null = noClosedHistory
    ? null
    : (trackRecord as TrackRecord & { roi?: number | null })?.roi ?? null;

  const entryCents = formatCents(entryPrice);
  const currentCents =
    currentPrice !== null ? formatCents(currentPrice) : null;
  const priceDelta =
    currentPrice !== null ? (currentPrice - entryPrice) * 100 : null;
  const deltaSign = priceDelta !== null && priceDelta >= 0 ? "+" : "";

  const entryVsCurrentValue =
    currentCents !== null
      ? `${entryCents} → ${currentCents}`
      : `${entryCents} → —`;

  const entryVsCurrentExplain =
    currentPrice === null
      ? "We don't have a live market price yet. Entry price is what the whale paid per share."
      : priceDelta !== null && priceDelta > 0
        ? `Price moved up ${deltaSign}${priceDelta.toFixed(1)}¢ since entry. The market now agrees more with this bet.`
        : priceDelta !== null && priceDelta < 0
          ? `Price moved down ${priceDelta.toFixed(1)}¢ since entry. Some edge may have faded — but the whale's thesis could still be right.`
          : "Price hasn't moved since entry. The same odds are still available.";

  const convictionTier =
    betSize >= 10000
      ? "top 1%"
      : betSize >= 5000
        ? "top 5%"
        : betSize >= 1000
          ? "top 10%"
          : "above whale threshold";

  if (error) {
    return (
      <section className="mb-8 rounded-xl border border-pulse-border bg-slate-800 p-6">
        <h2 className="mb-4 text-lg font-semibold text-white">
          📊 Whale Track Record
        </h2>
        <p className="text-sm text-red-400">
          Could not load track record: {error}
        </p>
      </section>
    );
  }

  if (walletUnavailable && !trackRecord) {
    return (
      <section className="mb-8 rounded-xl border border-pulse-border bg-slate-800 p-6">
        <h2 className="mb-2 text-lg font-semibold text-white">
          📊 Whale Track Record
        </h2>
        <p className="text-sm text-slate-400">
          Track record syncing — this whale&apos;s wallet history will be
          available shortly. Check back in a few minutes.
        </p>
      </section>
    );
  }

  if (waitingForWallet || loadingRecord) {
    return (
      <section className="mb-8 rounded-xl border border-pulse-border bg-slate-800 p-6">
        <h2 className="mb-1 text-lg font-semibold text-white">
          📊 Whale Track Record
        </h2>
        <p className="mb-4 text-sm text-slate-400">
          {waitingForWallet
            ? "Linking this trade to a wallet…"
            : "Loading track record…"}
        </p>
        <p className="mb-4 text-xs text-slate-500">
          {waitingForWallet
            ? "Live trades need a moment to connect to the whale's wallet history."
            : "Fetching closed positions from Polymarket."}
        </p>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <SkeletonBox key={i} />
          ))}
        </div>
      </section>
    );
  }

  return (
    <section className="mb-8 rounded-xl border border-pulse-border bg-slate-800 p-6">
      <h2 className="mb-1 text-lg font-semibold text-white">
        📊 Whale Track Record
      </h2>
      <p className="mb-4 text-sm text-slate-400">
        {hasEnoughHistory
          ? "Historical performance from this wallet's closed bets"
          : closedCount > 0
            ? `Limited history — only ${closedCount} closed bet${closedCount === 1 ? "" : "s"} on record`
            : "No closed bet history found for this wallet"}
      </p>

      {noClosedHistory && (
        <p className="mb-4 text-sm leading-relaxed text-slate-400">
          {openPositionCount > 0
            ? `This wallet has ${openPositionCount} open position${openPositionCount === 1 ? "" : "s"} but none have resolved yet, so there's no win/loss record to show. This could be a newer trader or someone holding long-term positions.`
            : "This wallet has no resolved bets yet, so there's no win/loss record to show. This could be a newer trader."}
        </p>
      )}

      {!hasEnoughHistory && closedCount > 0 && (
        <div className="mb-4 rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-4 py-3 text-sm text-yellow-300">
          Not enough history for a reliable track record yet. Treat signals with
          extra caution.
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <MetricBox
          value={formatWinRate(trackRecord?.winRate ?? null)}
          label="Win Rate"
          valueClassName={winRateColor(trackRecord?.winRate ?? null)}
          emptyValue={noClosedHistory}
          badge={noClosedHistory ? emptyMetricBadge : undefined}
          explain={
            closedCount > 0
              ? `This whale wins ${formatWinRate(trackRecord?.winRate ?? null)} of their closed bets. Higher = more trustworthy pattern.`
              : "Win rate needs at least one closed position to calculate."
          }
        />
        <MetricBox
          value={formatAvgReturn(trackRecord?.avgReturnPerBet ?? null)}
          label="Avg Return per Bet"
          valueClassName={avgReturnColor(trackRecord?.avgReturnPerBet ?? null)}
          emptyValue={noClosedHistory}
          badge={noClosedHistory ? emptyMetricBadge : undefined}
          explain={
            closedCount > 0
              ? `Average profit/loss per closed bet. Positive means this whale historically finds profitable spots.`
              : "Average return needs closed positions to calculate."
          }
        />
        <MetricBox
          value={formatRoiPct(roi)}
          label="ROI"
          valueClassName={roiColor(roi)}
          emptyValue={noClosedHistory}
          badge={noClosedHistory ? emptyMetricBadge : undefined}
          explain={
            closedCount > 0
              ? `Money-weighted return on closed bets. Positive means this whale's dollars historically grew.`
              : "ROI needs at least one closed position to calculate."
          }
        />
        <MetricBox
          value={trackRecord ? `${trackRecord.closedCount} closed` : "—"}
          label="Total Bets"
          explain={
            trackRecord
              ? `${trackRecord.totalBets} total positions tracked (${data?.openPositionCount ?? 0} still open). More history = more reliable stats.`
              : "How many bets this wallet has placed."
          }
        />
        <MetricBox
          value={entryVsCurrentValue}
          label="Entry vs Current Price"
          valueClassName={
            priceDelta !== null && priceDelta > 0
              ? "text-pulse-yes"
              : priceDelta !== null && priceDelta < 0
                ? "text-red-400"
                : "text-white"
          }
          explain={entryVsCurrentExplain}
        />
        <MetricBox
          value={formatDollars(betSize)}
          label="Whale Stake"
          explain={`${formatDollars(betSize)} on this trade — ${convictionTier} of all platform activity. Bigger bets signal stronger conviction.`}
        />
      </div>

      {data?.clvStats && <ClvCard stats={data.clvStats} />}

      {data?.categoryStats && data.categoryStats.length > 0 && (
        <CategoryRoiBreakdown categories={data.categoryStats} />
      )}

      <p className="mt-4 text-xs text-slate-500">
        Based on the last 50 closed positions from Polymarket
        {trackRecord && trackRecord.excludedEphemeralCount > 0
          ? ` (${trackRecord.excludedEphemeralCount} short-term bot market${trackRecord.excludedEphemeralCount === 1 ? "" : "s"} excluded)`
          : ""}
        .
        {data?.wallet && (
          <>
            {" "}
            Wallet:{" "}
            <span className="font-mono text-slate-400">
              {data.wallet.slice(0, 6)}…{data.wallet.slice(-4)}
            </span>
          </>
        )}
      </p>
    </section>
  );
}
