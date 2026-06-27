import type { ClvStats } from "@/lib/polymarket";
import type { CrossMarketEvStats } from "@/lib/crossMarketEvStats";
import {
  formatClvCents,
  isClvAverageEvComputable,
  type AverageEvDisplay,
} from "@/lib/averageEvDisplay";
import { fairSourceLabel } from "@/lib/crossMarketEvDisplay";

interface ClvCardProps {
  stats: ClvStats;
  averageEv?: AverageEvDisplay;
  crossMarketEvStats?: CrossMarketEvStats | null;
  /** Wallet has fewer than TRACK_RECORD_RELIABILITY_FLOOR closed bets. */
  lowSample?: boolean;
}

function clvColor(clv: number): string {
  if (clv >= 0.02) return "text-pulse-yes";
  if (clv >= 0) return "text-amber-400";
  return "text-red-400";
}

function clvSummary(clv: number): string {
  if (clv >= 0.02) {
    return "Consistently got better prices than where the market settled before resolution.";
  }
  if (clv >= 0) {
    return "Roughly in line with the closing price — small pricing edge, if any.";
  }
  return "Often paid worse than the closing price — wins may reflect luck more than skill.";
}

/**
 * Supplemental CLV detail below the headline Average EV metric.
 * Headline value lives in WhaleTrackRecord; this card expands coverage context.
 */
export default function ClvCard({
  stats,
  averageEv,
  crossMarketEvStats,
  lowSample = false,
}: ClvCardProps) {
  const {
    coverage,
    totalClosed,
    hasEnoughCoverage,
    avgClv,
    weightedClv,
    showWeighted,
    coverageFloor,
  } = stats;

  if (totalClosed === 0) return null;

  const coverageLabel = `${coverage} of ${totalClosed} closed bet${totalClosed === 1 ? "" : "s"}`;
  const clvPrimary = isClvAverageEvComputable(stats);
  const usingCrossMarket = averageEv?.mode === "cross_market";
  const usingFallback = averageEv?.mode === "avg_return_fallback";
  const crossMarketCoverage =
    crossMarketEvStats && crossMarketEvStats.totalEvaluated > 0
      ? `${crossMarketEvStats.coverage} of ${crossMarketEvStats.totalEvaluated} position${
          crossMarketEvStats.totalEvaluated === 1 ? "" : "s"
        }`
      : null;

  return (
    <div
      className={`mt-6 rounded-xl border p-5 ${
        lowSample
          ? "border-slate-700/40 bg-slate-900/25"
          : "border-slate-700 bg-slate-900/50"
      }`}
    >
      {lowSample && (
        <p className="mb-3 text-xs font-medium uppercase tracking-wide text-amber-200/80">
          Too few closed bets — closing-line detail is not reliable yet
        </p>
      )}
      <h3 className="mb-1 text-base font-semibold text-white">
        {clvPrimary
          ? "Closing-line detail"
          : usingCrossMarket
            ? "Cross-market EV detail"
            : "Why EV fell back to avg return"}
      </h3>
      <p className="mb-4 text-xs text-slate-400">
        {clvPrimary
          ? "Beat the Closing Line — did they get a better entry than the market's last consensus before settlement?"
          : usingCrossMarket
            ? "Matched sports bets priced against the other venue's live quote on the same game."
            : "We could not compute a reliable closing-line edge for this wallet."}
      </p>

      {usingCrossMarket && crossMarketEvStats?.avgEv != null ? (
        <div className="rounded-lg border border-slate-600/50 bg-slate-800/40 px-4 py-3">
          <p className="mb-2 text-sm font-medium text-slate-300">
            Average EV uses cross-market matches
            {crossMarketEvStats.fairSource
              ? ` vs ${fairSourceLabel(crossMarketEvStats.fairSource)}`
              : ""}
          </p>
          {crossMarketCoverage && (
            <p className="mb-2 text-sm text-slate-400">
              Measured on {crossMarketCoverage} with live venue quotes.
            </p>
          )}
          <p className="text-sm leading-relaxed text-slate-400">
            Closing-line EV was not available for enough bets, but deterministic
            sports matches found comparable prices on the other platform. This is
            forward-looking venue comparison, not settlement profit.
          </p>
        </div>
      ) : clvPrimary && avgClv != null ? (
        <>
          <p className="mb-3 text-sm font-medium text-slate-300">
            Measured on {coverageLabel} with a clean closing line.
          </p>

          {showWeighted && weightedClv != null && (
            <p className="mb-3 text-sm text-slate-400">
              Stake-weighted edge:{" "}
              <span
                className={`font-semibold ${
                  lowSample ? "text-slate-400" : clvColor(weightedClv)
                }`}
              >
                {formatClvCents(weightedClv)}
              </span>
            </p>
          )}

          <p className="text-sm leading-relaxed text-slate-400">
            {clvSummary(avgClv)}
          </p>
        </>
      ) : (
        <div className="rounded-lg border border-slate-600/50 bg-slate-800/40 px-4 py-3">
          <p className="mb-2 text-sm font-medium text-slate-300">
            {usingFallback
              ? "Closing-line EV is not computable for this wallet yet"
              : "Not enough clean closing lines to measure edge reliably yet"}
          </p>
          <p className="mb-2 text-sm leading-relaxed text-slate-400">
            Only{" "}
            <span className="font-semibold text-slate-300">{coverageLabel}</span>{" "}
            had a fresh consensus price shortly before settlement. The rest
            resolved too slowly, lacked price history, or never had a liquid
            pre-settlement line — so they&apos;re excluded on purpose.
          </p>
          {usingFallback && (
            <p className="mb-2 text-sm leading-relaxed text-amber-200/90">
              The slot above shows{" "}
              <span className="font-medium">avg return per bet</span> instead —
              historical profit/loss per closed position, not closing-line or
              cross-market edge.
            </p>
          )}
          {!usingFallback && !usingCrossMarket && crossMarketCoverage && (
            <p className="mb-2 text-sm leading-relaxed text-slate-400">
              Cross-market matches: {crossMarketCoverage} — not enough for
              Average EV ({crossMarketEvStats?.coverageFloor ?? coverageFloor}{" "}
              required).
            </p>
          )}
          {!hasEnoughCoverage && (
            <p className="text-xs text-slate-500">
              We need at least {coverageFloor} bets with valid closing lines
              before showing CLV-based Average EV. Political longshots and
              illiquid markets are the usual reason coverage is low.
            </p>
          )}
        </div>
      )}

      <p className="mt-4 text-xs leading-relaxed text-slate-500">
        The closing line is the market&apos;s last consensus price before it
        settled. Coverage is often a subset of closed bets. This measures
        pricing edge in cents, not dollar profit.
      </p>
    </div>
  );
}
