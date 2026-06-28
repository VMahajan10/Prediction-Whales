"use client";

import { useMemo } from "react";
import type { OutcomeBooks } from "@/lib/crossMarketEv";
import { formatEvPercent } from "@/lib/crossMarketEvDisplay";
import { resolveSyntheticArbitrageForTrade } from "@/lib/syntheticArbitrageEv";
import type { TradeEvInput } from "@/lib/resolveTradeCrossMarketEv";

interface AiArbitrageBadgeProps {
  trade: TradeEvInput;
  index: Map<string, OutcomeBooks>;
  className?: string;
}

export default function AiArbitrageBadge({
  trade,
  index,
  className = "",
}: AiArbitrageBadgeProps) {
  const result = useMemo(
    () => resolveSyntheticArbitrageForTrade(trade, index),
    [trade.source, trade.price, trade.slug, trade.ticker, index]
  );

  if (index.size === 0 || !result.qualifies || result.combinedEvPercent == null) {
    return null;
  }

  return (
    <span
      className={`inline-flex items-center rounded border border-pulse-accent/40 bg-pulse-accent/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-pulse-accent ${className}`}
      title={`Synthetic PM↔Kalshi arbitrage gap · ${formatEvPercent(result.combinedEvPercent)} combined EV`}
    >
      AI Arbitrage Opportunity
    </span>
  );
}
