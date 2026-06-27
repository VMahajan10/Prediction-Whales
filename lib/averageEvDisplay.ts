import type { ClvStats, TrackRecord } from "@/lib/polymarket";
import type { CrossMarketEvStats } from "@/lib/crossMarketEvStats";
import type { CrossMarketFairSource } from "@/lib/crossMarketEv";
import { fairSourceBadge, fairSourceLabel, formatEvPercent } from "@/lib/crossMarketEvDisplay";

export type AverageEvMode =
  | "clv"
  | "cross_market"
  | "avg_return_fallback"
  | "unavailable";

export interface AverageEvDisplay {
  mode: AverageEvMode;
  value: string;
  valueClassName: string;
  /** Primary slot title — always "Average EV" when data exists. */
  label: string;
  explain: string;
  badge?: string;
  coverageLabel?: string;
  /** Shown under label when using avg-return fallback. */
  fallbackSublabel?: string;
}

function formatClvCents(clv: number): string {
  const cents = clv * 100;
  const sign = cents >= 0 ? "+" : "";
  return `${sign}${cents.toFixed(1)}¢`;
}

function formatAvgReturnDollars(avg: number): string {
  const sign = avg >= 0 ? "+" : "";
  if (Math.abs(avg) >= 1000) {
    return `${sign}$${avg.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  }
  return `${sign}$${avg.toFixed(2)}`;
}

function clvColor(clv: number): string {
  if (clv >= 0.02) return "text-pulse-yes";
  if (clv >= 0) return "text-amber-400";
  return "text-red-400";
}

function avgReturnColor(avg: number): string {
  return avg >= 0 ? "text-pulse-yes" : "text-red-400";
}

function clvExplain(avgClv: number, coverageLabel: string): string {
  const edge =
    avgClv >= 0.02
      ? "Historically beat the closing consensus — bets were priced in their favor over time."
      : avgClv >= 0
        ? "Roughly in line with the closing line before settlement — a small pricing edge, if any."
        : "Often paid worse than the closing consensus — wins may reflect luck more than edge.";
  return `${edge} Measured on ${coverageLabel} with a clean pre-settlement closing line (not profit dollars).`;
}

export function isClvAverageEvComputable(
  clvStats: ClvStats | null | undefined
): boolean {
  return !!(
    clvStats &&
    clvStats.totalClosed > 0 &&
    clvStats.hasEnoughCoverage &&
    clvStats.avgClv != null
  );
}

export function isCrossMarketEvComputable(
  crossMarketEvStats: CrossMarketEvStats | null | undefined
): boolean {
  return !!(
    crossMarketEvStats &&
    crossMarketEvStats.totalEvaluated > 0 &&
    crossMarketEvStats.hasEnoughCoverage &&
    crossMarketEvStats.avgEv != null
  );
}

function crossMarketEvColor(ev: number): string {
  if (ev >= 2) return "text-pulse-yes";
  if (ev >= 0) return "text-amber-400";
  return "text-red-400";
}

function crossMarketEvExplain(
  avgEv: number,
  coverageLabel: string,
  fairSource: CrossMarketFairSource
): string {
  const edge =
    avgEv >= 2
      ? "Entry prices were often better than the matched venue's live quote on the same game."
      : avgEv >= 0
        ? "Roughly in line with the matched venue — a small cross-market edge, if any."
        : "Often paid worse than the matched venue's quote on the same game.";
  return `${edge} Measured on ${coverageLabel} with a live ${fairSourceLabel(fairSource)} reference (not closing-line or dollar P&L).`;
}

/**
 * Resolves the primary "Average EV" slot:
 * 1. CLV when coverage meets the floor
 * 2. Cross-market EV when sports matches have live venue quotes
 * 3. Avg return per bet (honestly labeled, not EV)
 */
export function resolveAverageEvDisplay(
  clvStats: ClvStats | null | undefined,
  trackRecord: TrackRecord | null | undefined,
  options?: {
    emptyMetricBadge?: string;
    crossMarketEvStats?: CrossMarketEvStats | null;
  }
): AverageEvDisplay {
  const emptyBadge = options?.emptyMetricBadge;
  const crossMarketEvStats = options?.crossMarketEvStats;
  const closedCount = trackRecord?.closedCount ?? 0;
  const noClosedHistory = closedCount === 0;

  if (noClosedHistory) {
    return {
      mode: "unavailable",
      value: "—",
      valueClassName: "text-slate-500",
      label: "Average EV",
      explain:
        "Needs at least one closed bet to estimate whether this whale finds profitable spots over time.",
      badge: emptyBadge,
    };
  }

  if (isClvAverageEvComputable(clvStats)) {
    const avgClv = clvStats!.avgClv!;
    const coverageLabel = `${clvStats!.coverage} of ${clvStats!.totalClosed} closed bet${
      clvStats!.totalClosed === 1 ? "" : "s"
    }`;
    return {
      mode: "clv",
      value: formatClvCents(avgClv),
      valueClassName: clvColor(avgClv),
      label: "Average EV",
      explain: clvExplain(avgClv, coverageLabel),
      badge: "From closing line",
      coverageLabel,
    };
  }

  if (isCrossMarketEvComputable(crossMarketEvStats)) {
    const avgEv = crossMarketEvStats!.avgEv!;
    const fairSource = crossMarketEvStats!.fairSource ?? "kalshi";
    const coverageLabel = `${crossMarketEvStats!.coverage} of ${crossMarketEvStats!.totalEvaluated} position${
      crossMarketEvStats!.totalEvaluated === 1 ? "" : "s"
    }`;
    return {
      mode: "cross_market",
      value: formatEvPercent(avgEv),
      valueClassName: crossMarketEvColor(avgEv),
      label: "Average EV",
      explain: crossMarketEvExplain(avgEv, coverageLabel, fairSource),
      badge: fairSourceBadge(fairSource),
      coverageLabel,
    };
  }

  const avgReturn = trackRecord?.avgReturnPerBet ?? null;
  if (avgReturn != null) {
    return {
      mode: "avg_return_fallback",
      value: formatAvgReturnDollars(avgReturn),
      valueClassName: avgReturnColor(avgReturn),
      label: "Avg Return per Bet",
      fallbackSublabel: "Not EV — historical P&L per closed bet",
      explain:
        "Closing-line and cross-market EV need more matched bets with trustworthy prices. Showing average profit/loss per closed bet instead — positive means this whale historically found profitable spots, but this is not an edge estimate.",
      badge: "Not EV",
      coverageLabel:
        clvStats && clvStats.totalClosed > 0
          ? `${clvStats.coverage} of ${clvStats.totalClosed} closed bets had a clean closing line`
          : crossMarketEvStats && crossMarketEvStats.totalEvaluated > 0
            ? `${crossMarketEvStats.coverage} of ${crossMarketEvStats.totalEvaluated} positions matched across venues`
            : undefined,
    };
  }

  return {
    mode: "unavailable",
    value: "—",
    valueClassName: "text-slate-500",
    label: "Average EV",
    explain:
      "Not enough data to estimate edge from closing lines or average return per bet.",
    badge: emptyBadge,
  };
}

export function applyLowSampleAverageEv(
  display: AverageEvDisplay,
  closedCount: number
): AverageEvDisplay {
  if (display.mode === "unavailable") return display;

  const n = `${closedCount} closed bet${closedCount === 1 ? "" : "s"}`;
  let value: string;
  if (display.mode === "clv") {
    value = `${display.value} closing-line edge on ${n}`;
  } else if (display.mode === "cross_market") {
    value = `${display.value} cross-market edge on ${n}`;
  } else {
    value = `${display.value} avg return on ${n}`;
  }

  return {
    ...display,
    value,
    valueClassName: "text-slate-400",
    badge: "Too few bets",
    explain: `Only ${n} — any edge or return figure can swing wildly and is not a reliable signal yet. Shown for transparency, not as a recommendation.`,
    fallbackSublabel: display.fallbackSublabel
      ? `${display.fallbackSublabel} (${n})`
      : undefined,
  };
}

export { formatClvCents };
