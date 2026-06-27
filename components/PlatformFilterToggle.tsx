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
      className={`flex gap-2 overflow-x-auto pb-1 ${className}`}
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
            className={`pulse-chip ${active ? "pulse-chip-active" : "pulse-chip-inactive"}`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
