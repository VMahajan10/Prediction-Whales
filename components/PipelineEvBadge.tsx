"use client";

import { formatEvPercent } from "@/lib/crossMarketEvDisplay";
import type { PipelineTradeEv } from "@/lib/evPipeline/types";
import { isResolvedPipelineTradeEv } from "@/lib/evPipeline/types";

interface PipelineEvBadgeProps {
  ev: PipelineTradeEv | null | undefined;
  className?: string;
}

function badgeClasses(netEvPercent: number): string {
  if (netEvPercent > 0) {
    return "border-emerald-500/40 bg-emerald-500/15 text-emerald-300 font-bold";
  }
  if (netEvPercent < -0.05) {
    return "border-red-500/30 bg-red-500/10 text-red-300/90";
  }
  return "border-slate-600/50 bg-slate-800/60 text-slate-400";
}

export default function PipelineEvBadge({
  ev,
  className = "",
}: PipelineEvBadgeProps) {
  if (!isResolvedPipelineTradeEv(ev)) return null;

  const label = formatEvPercent(ev.netEvPercent);
  const title = `AI pipeline EV · p_true ${(ev.pTrue * 100).toFixed(1)}¢ vs market ${(ev.pMarket * 100).toFixed(1)}¢`;

  return (
    <span
      className={`inline-flex shrink-0 items-center rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${badgeClasses(ev.netEvPercent)} ${className}`}
      title={title}
    >
      {label} EV
    </span>
  );
}

export function PipelineEvInline({
  ev,
  className = "",
}: PipelineEvBadgeProps) {
  if (!isResolvedPipelineTradeEv(ev)) return null;

  const netEvPercent = ev.netEvPercent;
  const positive = netEvPercent > 0;
  const negative = netEvPercent < -0.05;
  const color = positive
    ? "text-green-400 font-semibold"
    : negative
      ? "text-red-400/80"
      : "text-slate-400";

  return (
    <span
      className={`text-[11px] ${color} ${className}`}
      title={`AI pipeline · p_true ${(ev.pTrue * 100).toFixed(1)}¢ vs ${(ev.pMarket * 100).toFixed(1)}¢`}
    >
      {formatEvPercent(netEvPercent)} EV
    </span>
  );
}
