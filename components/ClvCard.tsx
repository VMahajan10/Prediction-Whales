import type { ClvStats } from "@/lib/polymarket";

interface ClvCardProps {
  stats: ClvStats;
}

function formatClvCents(clv: number): string {
  const cents = clv * 100;
  const sign = cents >= 0 ? "+" : "";
  return `${sign}${cents.toFixed(1)}¢`;
}

function formatEvDollars(n: number): string {
  const sign = n >= 0 ? "+" : "";
  return `${sign}$${Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function clvColor(clv: number): string {
  if (clv >= 0.02) return "text-pulse-yes";
  if (clv >= 0) return "text-amber-400";
  return "text-red-400";
}

function evColor(n: number): string {
  return n >= 0 ? "text-pulse-yes" : "text-red-400";
}

function clvSummary(clv: number): string {
  if (clv >= 0.02) {
    return "Consistently got better prices than where the market settled before resolution.";
  }
  if (clv >= 0) {
    return "Roughly in line with the closing price — small pricing edge, if any.";
  }
  return "Often paid worse than the closing price — wins may reflect luck more than edge.";
}

export default function ClvCard({ stats }: ClvCardProps) {
  const {
    coverage,
    totalClosed,
    hasEnoughCoverage,
    avgClv,
    weightedClv,
    showWeighted,
    totalEvDollars,
    avgEvPerBet,
  } = stats;

  if (totalClosed === 0) return null;

  const coverageLabel = `${coverage} of ${totalClosed} closed bet${totalClosed === 1 ? "" : "s"}`;

  return (
    <div className="mt-6 rounded-xl border border-slate-700 bg-slate-900/50 p-5">
      <h3 className="mb-1 text-base font-semibold text-white">
        Beat the Closing Line
      </h3>
      <p className="mb-4 text-xs text-slate-400">
        Did they get a better entry price than the market&apos;s last consensus
        before settlement?
      </p>

      {hasEnoughCoverage && avgClv != null ? (
        <>
          <div className="mb-2 flex flex-wrap items-baseline gap-3">
            <p
              className={`text-2xl font-bold tabular-nums ${clvColor(avgClv)}`}
            >
              {formatClvCents(avgClv)}
            </p>
            <p className="text-sm text-slate-400">
              avg edge vs closing price
            </p>
          </div>

          <p className="mb-3 text-sm font-medium text-slate-300">
            Measured on {coverageLabel} with a clean closing line.
          </p>

          {showWeighted && weightedClv != null && (
            <p className="mb-3 text-sm text-slate-400">
              Stake-weighted:{" "}
              <span className={`font-semibold ${clvColor(weightedClv)}`}>
                {formatClvCents(weightedClv)}
              </span>
            </p>
          )}

          <div className="mb-4 rounded-lg border border-slate-600/40 bg-slate-800/30 px-4 py-3">
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400">
              Expected Value
            </p>
            <p className="mb-1 text-sm text-slate-300">
              Avg EV per bet:{" "}
              <span className={`font-semibold tabular-nums ${evColor(avgEvPerBet)}`}>
                {formatEvDollars(avgEvPerBet)}
              </span>
            </p>
            <p className="mb-2 text-sm text-slate-300">
              Total EV captured:{" "}
              <span className={`font-semibold tabular-nums ${evColor(totalEvDollars)}`}>
                {formatEvDollars(totalEvDollars)}
              </span>
            </p>
            <p className="text-xs leading-relaxed text-slate-500">
              Expected value of this whale&apos;s entries versus the
              market&apos;s closing price, across {coverage} bet
              {coverage === 1 ? "" : "s"} with a clean closing line.
            </p>
          </div>

          <p className="text-sm leading-relaxed text-slate-400">
            {clvSummary(avgClv)}
          </p>
        </>
      ) : (
        <div className="rounded-lg border border-slate-600/50 bg-slate-800/40 px-4 py-3">
          <p className="mb-2 text-sm font-medium text-slate-300">
            Not enough clean closing lines to measure edge reliably yet
          </p>
          <p className="mb-2 text-sm leading-relaxed text-slate-400">
            Only <span className="font-semibold text-slate-300">{coverageLabel}</span>{" "}
            had a fresh consensus price shortly before settlement. The rest
            resolved too slowly, lacked price history, or never had a liquid
            pre-settlement line — so they&apos;re excluded on purpose, not
            because this feature is broken.
          </p>
          <p className="text-xs text-slate-500">
            We need at least {stats.coverageFloor} bets with valid closing lines
            before showing a headline number. Political longshots and illiquid
            markets are the usual reason coverage is low.
          </p>
        </div>
      )}

      <p className="mt-4 text-xs leading-relaxed text-slate-500">
        The closing line is the market&apos;s last consensus price before it
        settled. We exclude markets that resolved slowly or lacked a clean
        closing price, so coverage is often a subset of closed bets. This
        measures pricing edge, not profit.
      </p>
    </div>
  );
}
