"use client";

import { useEffect, useRef, useState } from "react";
import type { CategoryStats, ClvStats, TrackRecord } from "@/lib/polymarket";
import {
  repairTrackRecord,
  TRACK_RECORD_RELIABILITY_FLOOR,
} from "@/lib/polymarket";
import CategoryRoiBreakdown from "@/components/CategoryRoiBreakdown";
import ClvCard from "@/components/ClvCard";
import {
  applyLowSampleAverageEv,
  resolveAverageEvDisplay,
} from "@/lib/averageEvDisplay";

interface WhaleTrackRecordProps {
  proxyWallet?: string;
  walletUnavailable?: boolean;
  entryPrice: number;
  currentPrice: number | null;
  betSize: number;
  marketsLoading?: boolean;
  marketMatched?: boolean;
  marketClosed?: boolean;
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

function closedWinsFromTrack(track: TrackRecord): number {
  if (track.closedWins != null) return track.closedWins;
  if (track.winRate == null || track.closedCount === 0) return 0;
  return Math.round((track.winRate / 100) * track.closedCount);
}

function LowSampleBanner({
  closedCount,
  wins,
  floor,
}: {
  closedCount: number;
  wins: number;
  floor: number;
}) {
  const losses = closedCount - wins;
  return (
    <div
      className="mb-5 rounded-xl border-2 border-amber-500/60 bg-amber-500/20 px-5 py-4 shadow-sm"
      role="status"
    >
      <p className="text-xl font-bold text-amber-50">
        {wins} of {closedCount} closed bet{closedCount === 1 ? "" : "s"} won
        {losses > 0 ? ` · ${losses} lost` : ""}
      </p>
      <p className="mt-2 text-base font-semibold text-amber-100">
        Not enough history to trust these stats
      </p>
      <p className="mt-2 text-sm leading-relaxed text-amber-200/95">
        Only{" "}
        <span className="font-bold text-amber-50">{closedCount}</span> closed
        bet{closedCount === 1 ? "" : "s"} on record — we need at least{" "}
        <span className="font-bold text-amber-50">{floor}</span> before treating
        win rate, ROI, or average EV as meaningful. Percentages on a tiny sample
        look impressive by luck alone.
      </p>
    </div>
  );
}

function MetricBox({
  value,
  label,
  explain,
  valueClassName = "text-white",
  badge,
  emptyValue = false,
  sublabel,
  muted = false,
}: {
  value: string;
  label: string;
  explain: string;
  valueClassName?: string;
  badge?: string;
  emptyValue?: boolean;
  sublabel?: string;
  /** Low sample — grey, smaller headline; no green/red confidence colors. */
  muted?: boolean;
}) {
  const showEmpty = emptyValue && !muted;
  return (
    <div
      className={`rounded-xl border p-4 ${
        muted
          ? "border-slate-700/40 bg-slate-900/25"
          : "border-slate-700 bg-slate-900/50"
      }`}
    >
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <p
          className={`font-bold ${
            showEmpty
              ? "text-lg text-slate-500"
              : muted
                ? "text-base font-medium text-slate-400"
                : "text-xl"
          } ${showEmpty || muted ? "" : valueClassName}`}
        >
          {value}
        </p>
        {badge && (
          <span
            className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
              muted
                ? "bg-slate-700/40 text-slate-500"
                : "bg-slate-700/60 text-slate-400"
            }`}
          >
            {badge}
          </span>
        )}
      </div>
      <p
        className={`mb-0.5 text-xs font-medium ${
          muted ? "text-slate-500" : "text-slate-300"
        }`}
      >
        {label}
      </p>
      {sublabel && (
        <p className="mb-2 text-[11px] leading-snug text-slate-500">
          {sublabel}
        </p>
      )}
      {!sublabel && <div className="mb-2" />}
      <p
        className={`text-xs leading-relaxed ${
          muted ? "text-slate-500" : "text-slate-400"
        }`}
      >
        {explain}
      </p>
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
  marketsLoading = false,
  marketMatched = false,
  marketClosed = false,
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

  const trackRecord = data?.trackRecord
    ? repairTrackRecord(data.trackRecord)
    : null;
  const waitingForWallet = !proxyWallet && !walletUnavailable;
  const loadingRecord = !!proxyWallet && loading && !trackRecord;
  const hasEnoughHistory = trackRecord?.hasEnoughHistory ?? false;
  const closedCount = trackRecord?.closedCount ?? 0;
  const openPositionCount = data?.openPositionCount ?? 0;
  const noClosedHistory = closedCount === 0;
  const isLowSample = !noClosedHistory && !hasEnoughHistory;
  const emptyMetricBadge =
    openPositionCount > 0 ? "Open bets only" : "New wallet";
  const roi: number | null = noClosedHistory
    ? null
    : (trackRecord?.roi ?? null);

  let averageEv = resolveAverageEvDisplay(data?.clvStats, trackRecord, {
    emptyMetricBadge,
  });
  if (isLowSample && trackRecord) {
    averageEv = applyLowSampleAverageEv(averageEv, closedCount);
  }
  const showStandaloneAvgReturn =
    averageEv.mode === "clv" && !noClosedHistory && !isLowSample;

  const wins = trackRecord ? closedWinsFromTrack(trackRecord) : 0;
  const winRateDisplay = isLowSample && trackRecord
    ? {
        value: `${wins} of ${closedCount} won`,
        label: "Closed record",
        explain: `${formatWinRate(trackRecord.winRate)} on ${closedCount} bet${closedCount === 1 ? "" : "s"} — too small a sample to infer skill.`,
      }
    : {
        value: formatWinRate(trackRecord?.winRate ?? null),
        label: "Win Rate",
        explain:
          closedCount > 0
            ? `This whale wins ${formatWinRate(trackRecord?.winRate ?? null)} of their closed bets. Higher = more trustworthy pattern.`
            : "Win rate needs at least one closed position to calculate.",
      };

  const roiDisplay = noClosedHistory
    ? {
        value: "—",
        explain:
          openPositionCount > 0
            ? `ROI needs at least one closed bet. This wallet has ${openPositionCount} open position${openPositionCount === 1 ? "" : "s"} still unresolved.`
            : "No closed bets yet — ROI cannot be calculated until at least one position settles.",
      }
    : isLowSample && roi != null
    ? {
        value: `${closedCount} bet${closedCount === 1 ? "" : "s"} · ${formatRoiPct(roi)} so far`,
        explain: `Money-weighted return on only ${closedCount} closed bet${closedCount === 1 ? "" : "s"}. One or two outcomes can swing this wildly — not a reliable signal.`,
      }
    : roi != null
    ? {
        value: formatRoiPct(roi),
        explain:
          "Money-weighted return on closed bets. Positive means this whale's dollars historically grew.",
      }
    : {
        value: "—",
        explain:
          "Closed bets are on record but Polymarket did not return cost basis — ROI cannot be computed from this data.",
      };

  const entryCents = formatCents(entryPrice);
  const priceDelta =
    currentPrice !== null ? (currentPrice - entryPrice) * 100 : null;
  const deltaSign = priceDelta !== null && priceDelta >= 0 ? "+" : "";

  const hasLivePrice =
    currentPrice != null && Number.isFinite(currentPrice);

  const entryVsCurrentValue = hasLivePrice
    ? `${entryCents} → ${formatCents(currentPrice!)}`
    : `${entryCents} → —`;

  const entryVsCurrentExplain = marketsLoading
    ? "Fetching a live market quote for this contract…"
    : !marketMatched
      ? "Could not match this trade to a Polymarket market listing — no live quote to compare against entry."
      : marketClosed
        ? "This market has closed or resolved — there is no live order book, only the final outcome."
        : !hasLivePrice
          ? "Market matched but no live price returned yet. The feed may be slow, or this contract is illiquid."
          : priceDelta !== null && priceDelta > 0
            ? `Price moved up ${deltaSign}${priceDelta.toFixed(1)}¢ since entry. The market now prices this higher than when the whale entered.`
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
    <section
      className={`mb-8 rounded-xl border bg-slate-800 p-6 ${
        isLowSample ? "border-amber-500/35" : "border-pulse-border"
      }`}
    >
      {isLowSample && trackRecord && (
        <LowSampleBanner
          closedCount={closedCount}
          wins={wins}
          floor={TRACK_RECORD_RELIABILITY_FLOOR}
        />
      )}

      <h2 className="mb-1 text-lg font-semibold text-white">
        📊 Whale Track Record
      </h2>

      <p className="mb-4 text-sm text-slate-400">
        {hasEnoughHistory
          ? "Historical performance from this wallet's closed bets"
          : closedCount > 0
            ? isLowSample
              ? "Early snapshot — treat headline percentages as noise until more bets close"
              : `Early snapshot — ${closedCount} closed bet${closedCount === 1 ? "" : "s"} so far`
            : "No closed bet history found for this wallet"}
      </p>

      {noClosedHistory && (
        <p className="mb-4 text-sm leading-relaxed text-slate-400">
          {openPositionCount > 0
            ? `This wallet has ${openPositionCount} open position${openPositionCount === 1 ? "" : "s"} but none have resolved yet, so there's no win/loss record to show. This could be a newer trader or someone holding long-term positions.`
            : "This wallet has no resolved bets yet, so there's no win/loss record to show. This could be a newer trader."}
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <MetricBox
          value={averageEv.value}
          label={averageEv.label}
          sublabel={isLowSample ? undefined : averageEv.fallbackSublabel}
          valueClassName={averageEv.valueClassName}
          emptyValue={averageEv.mode === "unavailable"}
          badge={averageEv.badge}
          explain={averageEv.explain}
          muted={isLowSample}
        />
        <MetricBox
          value={winRateDisplay.value}
          label={winRateDisplay.label}
          valueClassName={winRateColor(trackRecord?.winRate ?? null)}
          emptyValue={noClosedHistory}
          badge={
            noClosedHistory
              ? emptyMetricBadge
              : isLowSample
                ? "Too few bets"
                : undefined
          }
          explain={winRateDisplay.explain}
          muted={isLowSample}
        />
        {showStandaloneAvgReturn && (
          <MetricBox
            value={formatAvgReturn(trackRecord?.avgReturnPerBet ?? null)}
            label="Avg Return per Bet"
            valueClassName={avgReturnColor(trackRecord?.avgReturnPerBet ?? null)}
            explain={`Average dollar profit per closed bet across this wallet's history — not this trade's ${formatDollars(betSize)} stake. Whales with large positions can show much bigger averages than today's bet size.`}
          />
        )}
        <MetricBox
          value={roiDisplay.value}
          label="ROI"
          valueClassName={roiColor(roi)}
          emptyValue={noClosedHistory || (closedCount > 0 && roi == null)}
          badge={
            noClosedHistory
              ? openPositionCount > 0
                ? "Open bets only"
                : "No closed bets yet"
              : isLowSample
                ? "Too few bets"
                : roi == null && closedCount > 0
                  ? "Cost basis missing"
                  : undefined
          }
          explain={roiDisplay.explain}
          muted={isLowSample}
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
            hasLivePrice && priceDelta !== null && priceDelta > 0
              ? "text-pulse-yes"
              : hasLivePrice && priceDelta !== null && priceDelta < 0
                ? "text-red-400"
                : "text-white"
          }
          badge={
            !hasLivePrice
              ? marketsLoading
                ? "Loading quote"
                : !marketMatched
                  ? "Unmatched market"
                  : marketClosed
                    ? "Market closed"
                    : "No live quote"
              : undefined
          }
          explain={entryVsCurrentExplain}
        />
        <MetricBox
          value={formatDollars(betSize)}
          label="Whale Stake"
          explain={`${formatDollars(betSize)} on this trade — ${convictionTier} of all platform activity. Bigger bets signal stronger conviction.`}
        />
      </div>

      {data?.clvStats && (
        <ClvCard
          stats={data.clvStats}
          averageEv={averageEv}
          lowSample={isLowSample}
        />
      )}

      {data?.categoryStats &&
        data.categoryStats.length > 0 &&
        !isLowSample && (
        <CategoryRoiBreakdown categories={data.categoryStats} />
      )}

      <p className="mt-4 text-xs text-slate-500">
        Based on the last 50 closed positions from Polymarket
        {trackRecord && trackRecord.excludedEphemeralCount > 0
          ? ` (${trackRecord.excludedEphemeralCount} short-term bot market${trackRecord.excludedEphemeralCount === 1 ? "" : "s"} excluded)`
          : ""}
        .
        {proxyWallet && (
          <>
            {" "}
            Wallet:{" "}
            <span className="font-mono text-slate-400">
              {proxyWallet.slice(0, 6)}…{proxyWallet.slice(-4)}
            </span>
          </>
        )}
      </p>
    </section>
  );
}
