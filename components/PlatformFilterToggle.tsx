"use client";

import {
  LIVE_FEED_PLATFORM_OPTIONS,
  type LiveFeedPlatform,
} from "@/lib/liveFeedPlatform";

interface PlatformFilterToggleProps {
  value: LiveFeedPlatform;
  onChange: (platform: LiveFeedPlatform) => void;
  className?: string;
}

export default function PlatformFilterToggle({
  value,
  onChange,
  className = "",
}: PlatformFilterToggleProps) {
  return (
    <div
      className={`flex rounded-lg border border-slate-600/80 bg-slate-800/80 p-0.5 ${className}`}
      role="group"
      aria-label="Filter trades by platform"
    >
      {LIVE_FEED_PLATFORM_OPTIONS.map((option) => {
        const active = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            aria-pressed={active}
            className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              active
                ? "bg-slate-600 text-white shadow-sm"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
