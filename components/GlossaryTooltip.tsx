"use client";

import type { ReactNode } from "react";

interface GlossaryTooltipProps {
  term: string;
  definition: string;
  children: ReactNode;
}

export default function GlossaryTooltip({
  term,
  definition,
  children,
}: GlossaryTooltipProps) {
  return (
    <span className="group relative inline-flex items-center gap-1">
      {children}
      <span
        className="cursor-help text-xs text-pulse-muted"
        aria-label={`${term}: ${definition}`}
      >
        ⓘ
      </span>
      <span className="pointer-events-none absolute bottom-full left-0 z-50 mb-2 hidden w-48 rounded-lg bg-slate-900 px-3 py-2 text-sm text-white shadow-lg group-hover:block">
        <span className="font-medium">{term}</span>
        <span className="mt-1 block text-slate-300">{definition}</span>
      </span>
    </span>
  );
}
