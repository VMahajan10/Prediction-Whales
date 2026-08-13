"use client";

import { AI_INSIGHT_DISCLAIMER_TEXT } from "@/lib/legalCompliance";
import { formatEvPercent } from "@/lib/crossMarketEvDisplay";
import type { PipelineTradeEv } from "@/lib/evPipeline/types";
import {
  pipelineEvTooltip,
  resolvePipelineDisplayEv,
} from "@/lib/evPipeline/tradeEvRecord";

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

function evLabel(netEvPercent: number, lowConfidence: boolean): string {
  const formatted = formatEvPercent(netEvPercent);
  return lowConfidence ? `~${formatted}` : formatted;
}

export default function PipelineEvBadge({
  ev,
  className = "",
}: PipelineEvBadgeProps) {
  const display = resolvePipelineDisplayEv(ev);
  if (!display) return null;

  const label = evLabel(display.netEvPercent, display.lowConfidence);

  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${badgeClasses(display.netEvPercent)} ${className}`}
      title={`${pipelineEvTooltip(ev!, display)} · ${AI_INSIGHT_DISCLAIMER_TEXT}`}
    >
      <span>{label} EV</span>
      {display.lowConfidence ? (
        <span className="rounded bg-amber-500/20 px-1 text-[8px] font-bold text-amber-200/90">
          EST
        </span>
      ) : null}
    </span>
  );
}

export function PipelineEvInline({
  ev,
  className = "",
}: PipelineEvBadgeProps) {
  const display = resolvePipelineDisplayEv(ev);
  if (!display) return null;

  const positive = display.netEvPercent > 0;
  const negative = display.netEvPercent < -0.05;
  const color = positive
    ? "text-green-400 font-semibold"
    : negative
      ? "text-red-400/80"
      : "text-slate-400";

  return (
    <span
      className={`inline-flex items-center gap-1 text-[11px] ${color} ${className}`}
      title={`${pipelineEvTooltip(ev!, display)} · ${AI_INSIGHT_DISCLAIMER_TEXT}`}
    >
      <span>{evLabel(display.netEvPercent, display.lowConfidence)} EV</span>
      {display.lowConfidence ? (
        <span className="text-[9px] font-semibold uppercase text-amber-300/80">
          est
        </span>
      ) : null}
    </span>
  );
}
