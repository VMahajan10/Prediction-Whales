"use client";

import {
  buildNeutralArbitrageSnapshot,
  type ArbitrageDisplaySnapshot,
} from "@/lib/arbitrageFinder/displayTypes";
import { useArbitrageDisplay } from "@/lib/hooks/useArbitrageDisplay";

function formatCents(price: number): string {
  return `${(price * 100).toFixed(1)}¢`;
}

function formatUsd(value: number): string {
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

function snapshotTooltip(snapshot: ArbitrageDisplaySnapshot): string {
  const [legA, legB] = snapshot.legs;
  const parts = [
    snapshot.label,
    `Implied sum ${snapshot.impliedSumPercent.toFixed(1)}%`,
    snapshot.isExecutable && snapshot.hasSub100Edge
      ? `Lock margin ${snapshot.roiPercent.toFixed(1)}% ROI`
      : null,
    `${legA.venue.toUpperCase()} ${legA.side} @ ${formatCents(legA.askPrice)} (${legA.source})`,
    `${legB.venue.toUpperCase()} ${legB.side} @ ${formatCents(legB.askPrice)} (${legB.source})`,
    snapshot.stakePlan
      ? `Stake split ${formatUsd(snapshot.stakePlan.legStakesUsd[0])} / ${formatUsd(snapshot.stakePlan.legStakesUsd[1])}`
      : null,
    snapshot.degraded ? "Estimated quotes (not all live order books)" : null,
  ].filter(Boolean);
  return parts.join(" · ");
}

function toneClasses(
  snapshot: ArbitrageDisplaySnapshot | null,
  loading: boolean
): string {
  if (loading) return "border-pulse-border/80 bg-pulse-surface/60 text-zinc-500";
  if (snapshot?.hasSub100Edge) {
    return "border-emerald-500/40 bg-emerald-500/10 text-emerald-300";
  }
  return "border-pulse-border/80 bg-pulse-surface/60 text-pulse-label";
}

function valueToneClass(snapshot: ArbitrageDisplaySnapshot): string {
  if (snapshot.hasSub100Edge) return "text-emerald-400";
  return "text-pulse-label";
}

function formatCompactValue(snapshot: ArbitrageDisplaySnapshot): string {
  const sum = `${snapshot.impliedSumPercent.toFixed(1)}%`;
  if (snapshot.hasSub100Edge && snapshot.isExecutable) {
    return `${sum} · +${snapshot.roiPercent.toFixed(1)}% lock`;
  }
  if (snapshot.hasSub100Edge) return `${sum} · estimated edge`;
  return `${sum} sum`;
}

export interface ArbitrageDiscrepancyBoxProps {
  source?: "polymarket" | "kalshi" | "auto";
  pmTokenId?: string | null;
  kalshiTicker?: string | null;
  tradeOutcomeSide?: string | null;
  tradePrice?: number | null;
  title?: string | null;
  slug?: string | null;
  pmMid?: number | null;
  baseStakeUsd?: number | null;
  compact?: boolean;
  fullWidth?: boolean;
  className?: string;
  enabled?: boolean;
}

export default function ArbitrageDiscrepancyBox({
  source = "auto",
  pmTokenId,
  kalshiTicker,
  tradeOutcomeSide,
  tradePrice,
  title,
  slug,
  pmMid,
  baseStakeUsd,
  compact = false,
  fullWidth = false,
  className = "",
  enabled = true,
}: ArbitrageDiscrepancyBoxProps) {
  const hasIdentifier = !!(pmTokenId || kalshiTicker);
  const { snapshot, loading, error } = useArbitrageDisplay({
    source,
    pmTokenId,
    kalshiTicker,
    tradeOutcomeSide,
    tradePrice,
    title,
    slug,
    pmMid,
    baseStakeUsd,
    enabled: enabled && hasIdentifier,
  });

  if (!hasIdentifier) return null;

  const effectiveSnapshot =
    snapshot ??
    buildNeutralArbitrageSnapshot({
      venue:
        source === "kalshi" || (!pmTokenId && kalshiTicker)
          ? "kalshi"
          : "polymarket",
      contractId: pmTokenId ?? kalshiTicker ?? "unknown",
      referencePrice: tradePrice ?? pmMid,
    });
  const label = effectiveSnapshot.label;
  const tooltip = `${snapshotTooltip(effectiveSnapshot)}${
    error ? ` · Live pricing unavailable: ${error}` : ""
  }`;
  const showLockSubtext =
    effectiveSnapshot.isExecutable &&
    effectiveSnapshot.hasSub100Edge &&
    !loading &&
    !error;

  if (compact) {
    return (
      <div
        className={`inline-flex min-w-0 flex-col rounded-lg border px-3 py-2.5 ${fullWidth ? "w-full" : "flex-1"} ${toneClasses(snapshot, loading)} ${className}`}
        title={tooltip}
        data-testid="arbitrage-discrepancy-box"
      >
        <p className="text-[10px] font-semibold uppercase tracking-wide text-pulse-muted">
          {label}
        </p>
        {loading ? (
          <p className="mt-1 text-sm font-bold animate-pulse">…</p>
        ) : (
          <p
            className={`mt-1 text-sm font-bold ${valueToneClass(effectiveSnapshot)}`}
          >
            {formatCompactValue(effectiveSnapshot)}
            {showLockSubtext ? (
              <span className="ml-1 text-[10px] font-semibold opacity-80">
                (executable)
              </span>
            ) : null}
          </p>
        )}
        {effectiveSnapshot.degraded && !loading ? (
          <p className="mt-0.5 text-[9px] uppercase tracking-wide text-amber-300/80">
            estimated
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <section
      className={`rounded-lg border border-pulse-border bg-pulse-surface/80 px-3 py-3 ${className}`}
      data-testid="arbitrage-discrepancy-box"
    >
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-[10px] font-bold uppercase tracking-wide text-pulse-muted">
          {label}
        </p>
        {showLockSubtext ? (
          <span className="rounded bg-emerald-500/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-400">
            +{effectiveSnapshot.roiPercent.toFixed(1)}% lock
          </span>
        ) : null}
      </div>

      {loading ? (
        <p className="text-sm text-zinc-500 animate-pulse">
          Scanning order books…
        </p>
      ) : effectiveSnapshot.hasSub100Edge ? (
        <div className="space-y-2">
          <p className="text-sm font-semibold text-emerald-300">
            Implied sum {effectiveSnapshot.impliedSumPercent.toFixed(1)}% —{" "}
            {effectiveSnapshot.isExecutable
              ? "sub-100% box lock"
              : "estimated sub-100% edge"}
          </p>
          <p className="text-xs text-pulse-label">
            {effectiveSnapshot.legs[0].venue.toUpperCase()}{" "}
            {effectiveSnapshot.legs[0].side} @{" "}
            {formatCents(effectiveSnapshot.legs[0].askPrice)} +{" "}
            {effectiveSnapshot.legs[1].venue.toUpperCase()}{" "}
            {effectiveSnapshot.legs[1].side} @{" "}
            {formatCents(effectiveSnapshot.legs[1].askPrice)} ={" "}
            {formatCents(effectiveSnapshot.combinedCost)} combined
          </p>
          {effectiveSnapshot.isExecutable && effectiveSnapshot.stakePlan ? (
            <div className="rounded-md border border-pulse-border/80 bg-black/30 px-2.5 py-2 text-xs text-pulse-label">
              <p>
                Stake split on{" "}
                {formatUsd(effectiveSnapshot.stakePlan.totalStakeUsd)}:{" "}
                {formatUsd(effectiveSnapshot.stakePlan.legStakesUsd[0])} ·{" "}
                {formatUsd(effectiveSnapshot.stakePlan.legStakesUsd[1])}
              </p>
              <p className="mt-1 text-emerald-300/90">
                Locked profit{" "}
                {formatUsd(effectiveSnapshot.stakePlan.lockedProfitUsd)} (payout{" "}
                {formatUsd(effectiveSnapshot.stakePlan.guaranteedPayoutUsd)})
              </p>
            </div>
          ) : null}
        </div>
      ) : (
        <p className="text-sm text-pulse-label">
          Implied sum {effectiveSnapshot.impliedSumPercent.toFixed(1)}% — no
          risk-free lock at current quotes.
        </p>
      )}

      {effectiveSnapshot.degraded ? (
        <p className="mt-2 text-[10px] text-amber-300/90">
          Includes estimated proxy quotes — not all legs from live order books.
        </p>
      ) : null}
    </section>
  );
}
