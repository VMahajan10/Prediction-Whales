"use client";

import Link from "next/link";
import {
  formatArbLockLabel,
  formatArbPairLabel,
} from "@/lib/arbitrageFinder/feedUtils";
import type { ArbitrageWindow, ArbWindowStrategy } from "@/lib/arbitrageFinder/types";
import { useArbitrageScan } from "@/lib/hooks/useArbitrageScan";

function strategyShortLabel(strategy: ArbWindowStrategy): string {
  if (strategy === "pm_yes_kalshi_no") return "PM YES + K NO";
  return "K YES + PM NO";
}

function formatUsd(value: number): string {
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

function ArbWindowRow({ window }: { window: ArbitrageWindow }) {
  const href = `/markets/${encodeURIComponent(window.kalshiTicker)}`;

  return (
    <Link
      href={href}
      className="block rounded-lg border border-pulse-border/80 bg-pulse-surface/80 px-3 py-2.5 transition-colors hover:border-emerald-500/30 hover:bg-emerald-500/5"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-xs font-semibold text-white">
            {formatArbPairLabel(window)}
          </p>
          <p className="mt-0.5 text-[10px] uppercase tracking-wide text-pulse-muted">
            {strategyShortLabel(window.strategy)} ·{" "}
            {window.impliedSumPercent.toFixed(1)}% implied sum
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-sm font-bold text-emerald-400">
            {formatArbLockLabel(window)}
          </p>
          {window.stakePlan ? (
            <p className="mt-0.5 text-[10px] text-emerald-300/80">
              +{formatUsd(window.stakePlan.lockedProfitUsd)} on{" "}
              {formatUsd(window.stakePlan.totalStakeUsd)}
            </p>
          ) : null}
        </div>
      </div>
    </Link>
  );
}

export interface ArbitrageOpportunityFeedProps {
  className?: string;
  mappingLimit?: number;
  top?: number;
  defaultStakeUsd?: number;
}

export default function ArbitrageOpportunityFeed({
  className = "",
  mappingLimit,
  top = 8,
  defaultStakeUsd = 500,
}: ArbitrageOpportunityFeedProps) {
  const { windows, scannedPairs, actionableCount, loading, scanDurationMs } =
    useArbitrageScan({
      mappingLimit,
      top,
      stakeUsd: defaultStakeUsd,
    });

  return (
    <section
      className={`${className}`}
      data-testid="arbitrage-opportunity-feed"
    >
      <div className="mb-3 flex items-end justify-between gap-2">
        <div>
          <h2 className="text-sm font-bold uppercase tracking-wide text-white">
            Cross-Venue Locks
          </h2>
          <p className="mt-0.5 text-[10px] uppercase tracking-wide text-pulse-label">
            Sub-100% PM ↔ Kalshi boxes · independent of Avg. EV
          </p>
        </div>
        {!loading && scannedPairs > 0 ? (
          <p className="text-[10px] text-pulse-muted">
            {actionableCount} lock{actionableCount === 1 ? "" : "s"} /{" "}
            {scannedPairs} pairs
            {scanDurationMs > 0 ? ` · ${scanDurationMs}ms` : ""}
          </p>
        ) : null}
      </div>

      <div className="pulse-card p-3">
        {loading && windows.length === 0 ? (
          <p className="py-4 text-center text-sm text-pulse-muted animate-pulse">
            Scanning mapped order books…
          </p>
        ) : windows.length === 0 ? (
          <p className="py-4 text-center text-sm text-pulse-muted">
            No sub-100% cross-venue locks right now
          </p>
        ) : (
          <ul className="space-y-2">
            {windows.map((window) => (
              <li key={window.windowId}>
                <ArbWindowRow window={window} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
