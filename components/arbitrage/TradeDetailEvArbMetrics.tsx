"use client";

import ArbitrageDiscrepancyBox from "@/components/arbitrage/ArbitrageDiscrepancyBox";
import { PipelineEvInline } from "@/components/PipelineEvBadge";
import { formatEvPercent } from "@/lib/crossMarketEvDisplay";
import type { PipelineTradeEv } from "@/lib/evPipeline/types";
import {
  pipelineEvTone,
  resolveDetailPanelDisplayEv,
} from "@/lib/evPipeline/tradeEvRecord";

export interface TradeDetailEvArbMetricsProps {
  pipelineData: PipelineTradeEv | null | undefined;
  pipelineLoading?: boolean;
  source?: "polymarket" | "kalshi" | "auto";
  pmTokenId?: string | null;
  kalshiTicker?: string | null;
  tradeOutcomeSide?: string | null;
  tradePrice?: number | null;
  title?: string | null;
  slug?: string | null;
  pmMid?: number | null;
  baseStakeUsd?: number | null;
  /** Cached trade-level EV % when pipeline lookup is cold. */
  tradeEvPercent?: number | null;
  className?: string;
}

/**
 * Side-by-side Average EV (pipeline) and arbitrage sum metrics.
 * Independent data paths — neither overrides the other.
 */
export default function TradeDetailEvArbMetrics({
  pipelineData,
  pipelineLoading = false,
  source = "auto",
  pmTokenId,
  kalshiTicker,
  tradeOutcomeSide,
  tradePrice,
  title,
  slug,
  pmMid,
  baseStakeUsd,
  tradeEvPercent = null,
  className = "",
}: TradeDetailEvArbMetricsProps) {
  const pipelineDisplay = resolveDetailPanelDisplayEv(
    pipelineData,
    tradePrice
  );
  const hasPipelineEv = pipelineDisplay != null;
  const hasTradeEv =
    tradeEvPercent != null && Number.isFinite(tradeEvPercent);
  const hasArbIdentifier = !!(pmTokenId || kalshiTicker);

  if (!hasPipelineEv && !hasTradeEv && !hasArbIdentifier) return null;

  return (
    <div
      className={`grid grid-cols-2 gap-2 ${className}`}
      data-testid="trade-detail-ev-arb-metrics"
    >
      <div className="rounded-lg bg-pulse-surface px-3 py-2.5">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-pulse-muted">
          Avg. EV
        </p>
        {pipelineLoading ? (
          <p className="mt-1 text-sm font-bold text-zinc-500 animate-pulse">…</p>
        ) : hasPipelineEv ? (
          <div className="mt-1">
            <PipelineEvInline ev={pipelineData} className="text-sm font-bold" />
          </div>
        ) : hasTradeEv ? (
          <p
            className={`mt-1 text-sm font-bold ${
              pipelineEvTone(tradeEvPercent!).positive
                ? "text-green-400"
                : pipelineEvTone(tradeEvPercent!).negative
                  ? "text-red-400/80"
                  : "text-slate-400"
            }`}
          >
            {formatEvPercent(tradeEvPercent!)} EV
          </p>
        ) : (
          <p className="mt-1 text-sm font-bold text-zinc-500">—</p>
        )}
      </div>

      <ArbitrageDiscrepancyBox
        source={source}
        pmTokenId={pmTokenId}
        kalshiTicker={kalshiTicker}
        tradeOutcomeSide={tradeOutcomeSide}
        tradePrice={tradePrice}
        title={title}
        slug={slug}
        pmMid={pmMid ?? pipelineData?.pmMid}
        baseStakeUsd={baseStakeUsd}
        compact
      />
    </div>
  );
}
