"use client";

import { useMemo } from "react";
import { resolveTraderIntelligence } from "@/lib/traderIntelligence";
import { useWhaleTrackRecord } from "@/lib/useWhaleTrackRecord";

interface TraderIntelligenceCardProps {
  wallet: string;
}

function scoreColor(score: number | null): string {
  if (score == null) return "text-pulse-muted";
  if (score >= 70) return "text-pulse-yes";
  if (score >= 45) return "text-pulse-accent";
  return "text-pulse-muted";
}

function evColor(evLabel: string): string {
  if (evLabel === "—") return "text-pulse-muted";
  if (evLabel.startsWith("+")) return "text-pulse-yes";
  if (evLabel.startsWith("-")) return "text-pulse-no";
  return "text-white";
}

export default function TraderIntelligenceCard({
  wallet,
}: TraderIntelligenceCardProps) {
  const { data, trackRecord, loading } = useWhaleTrackRecord(wallet);

  const intelligence = useMemo(() => {
    if (data?.traderIntelligence) return data.traderIntelligence;
    return resolveTraderIntelligence(
      data?.clvStats,
      data?.crossMarketEvStats,
      trackRecord
    );
  }, [
    data?.traderIntelligence,
    data?.clvStats,
    data?.crossMarketEvStats,
    trackRecord,
  ]);

  return (
    <section className="pulse-card mb-6 border border-pulse-border p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-[11px] font-bold uppercase tracking-wide text-pulse-label">
          Trader Intelligence
        </h2>
        {intelligence.source !== "unavailable" && (
          <span className="rounded bg-pulse-accent/15 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide text-pulse-accent">
            {intelligence.source === "pipeline" ? "Pipeline EV" : "AI + EV"}
          </span>
        )}
      </div>

      {loading && !trackRecord ? (
        <div className="grid grid-cols-2 gap-3 animate-pulse">
          <div className="h-16 rounded-lg bg-pulse-surface" />
          <div className="h-16 rounded-lg bg-pulse-surface" />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-lg bg-pulse-surface px-3 py-3">
              <p className="text-[10px] font-bold uppercase tracking-wide text-pulse-label">
                Average Strategy EV
              </p>
              <p
                className={`mt-1 text-2xl font-bold tabular-nums ${evColor(intelligence.averageStrategyEvLabel)}`}
              >
                {intelligence.averageStrategyEvLabel}
              </p>
              <p className="mt-1 text-[10px] text-pulse-muted">
                {intelligence.totalEvaluated > 0
                  ? `${intelligence.coverage} of ${intelligence.totalEvaluated} positions`
                  : "Historic tracked positions"}
              </p>
            </div>

            <div className="rounded-lg bg-pulse-surface px-3 py-3">
              <p className="text-[10px] font-bold uppercase tracking-wide text-pulse-label">
                AI Edge Score
              </p>
              <p
                className={`mt-1 text-2xl font-bold tabular-nums ${scoreColor(intelligence.aiEdgeScore)}`}
              >
                {intelligence.aiEdgeScore != null
                  ? `${intelligence.aiEdgeScore}`
                  : "—"}
                {intelligence.aiEdgeScore != null && (
                  <span className="ml-1 text-sm font-semibold text-pulse-muted">
                    / 100
                  </span>
                )}
              </p>
              <p className="mt-1 text-[10px] text-pulse-muted">
                True EV vs market discrepancies
              </p>
            </div>
          </div>

          <p className="mt-3 text-xs leading-relaxed text-pulse-muted">
            {intelligence.explain}
          </p>
        </>
      )}
    </section>
  );
}
