"use client";

import {
  LIVE_FEED_PLATFORM_OPTIONS,
  type LiveFeedPlatform,
} from "@/lib/liveFeedPlatform";

interface WhaleFeedPlatformFilterProps {
  value: LiveFeedPlatform;
  onChange: (platform: LiveFeedPlatform) => void;
  className?: string;
}

/** Secondary platform filter — category tabs are primary navigation. */
export default function WhaleFeedPlatformFilter({
  value,
  onChange,
  className = "",
}: WhaleFeedPlatformFilterProps) {
  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <span className="shrink-0 text-[10px] font-bold uppercase tracking-wide text-pulse-label">
        Platform
      </span>
      <div
        className="flex gap-1.5 overflow-x-auto pb-0.5"
        role="group"
        aria-label="Filter by platform"
      >
        {LIVE_FEED_PLATFORM_OPTIONS.map((option) => {
          const active = value === option.value;
          return (
            <button
              key={option.value}
              type="button"
              onClick={() => onChange(option.value)}
              aria-pressed={active}
              className={`shrink-0 rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide transition-colors ${
                active
                  ? "border-white/30 bg-white/10 text-white"
                  : "border-pulse-border bg-transparent text-pulse-muted hover:text-white"
              }`}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
