"use client";

import { useMemo } from "react";
import type { OutcomeBooks } from "@/lib/crossMarketEv";
import {
  evColorClass,
  fairSourceLabel,
  formatEvPercent,
} from "@/lib/crossMarketEvDisplay";
import {
  resolveCrossMarketEvForTrade,
  type TradeEvInput,
} from "@/lib/resolveTradeCrossMarketEv";

interface CrossMarketEvBadgeProps {
  trade: TradeEvInput;
  index: Map<string, OutcomeBooks>;
  className?: string;
  compact?: boolean;
}

export default function CrossMarketEvBadge({
  trade,
  index,
  className = "",
  compact = false,
}: CrossMarketEvBadgeProps) {
  const result = useMemo(
    () => resolveCrossMarketEvForTrade(trade, index),
    [trade.source, trade.price, trade.slug, trade.ticker, index]
  );

  if (index.size === 0) return null;

  if (result.reason !== "ok" || result.ev == null || !result.fairSource) {
    return null;
  }

  const color = evColorClass(result.ev);

  if (compact) {
    return (
      <span
        className={`text-[11px] font-medium ${color} ${className}`}
        title={`vs ${fairSourceLabel(result.fairSource)} price on the same game`}
      >
        {formatEvPercent(result.ev)} EV
      </span>
    );
  }

  return (
    <div
      className={`rounded-md border border-slate-700/80 bg-slate-900/40 px-3 py-2 ${className}`}
    >
      <p className={`text-sm font-semibold ${color}`}>
        {formatEvPercent(result.ev)} EV
      </p>
      <p className="mt-0.5 text-xs text-slate-500">
        vs {fairSourceLabel(result.fairSource)} price on the same game
      </p>
    </div>
  );
}
