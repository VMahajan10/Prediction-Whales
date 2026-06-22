import type { ClvStats, TrackRecord } from "@/lib/polymarket";

export type AverageEvMode = "clv" | "avg_return_fallback" | "unavailable";

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

/**
 * Resolves the primary "Average EV" slot: CLV when coverage meets the floor,
 * otherwise avg return per bet (historical P&L fallback).
 */
export function resolveAverageEvDisplay(
  clvStats: ClvStats | null | undefined,
  trackRecord: TrackRecord | null | undefined,
  options?: { emptyMetricBadge?: string }
): AverageEvDisplay {
  const emptyBadge = options?.emptyMetricBadge;
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

  const avgReturn = trackRecord?.avgReturnPerBet ?? null;
  if (avgReturn != null) {
    return {
      mode: "avg_return_fallback",
      value: formatAvgReturnDollars(avgReturn),
      valueClassName: avgReturnColor(avgReturn),
      label: "Average EV",
      fallbackSublabel:
        "Avg return per bet — EV not computable for this wallet",
      explain:
        "Closing-line EV needs more bets with a clean pre-settlement price. Showing average profit/loss per closed bet instead — positive means this whale historically found profitable spots.",
      badge: "Fallback",
      coverageLabel:
        clvStats && clvStats.totalClosed > 0
          ? `${clvStats.coverage} of ${clvStats.totalClosed} closed bets had a clean closing line`
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
