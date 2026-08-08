"use client";

import {
  WHALE_FEED_CATEGORY_TABS,
  type WhaleFeedCategoryTab,
} from "@/lib/constants/categories";

interface WhaleFeedCategoryTabsProps {
  value: WhaleFeedCategoryTab;
  onChange: (tab: WhaleFeedCategoryTab) => void;
  className?: string;
}

export default function WhaleFeedCategoryTabs({
  value,
  onChange,
  className = "",
}: WhaleFeedCategoryTabsProps) {
  return (
    <div
      className={`flex gap-2 overflow-x-auto pb-1 ${className}`}
      role="tablist"
      aria-label="Filter whale feed by category"
    >
      {WHALE_FEED_CATEGORY_TABS.map((option) => {
        const active = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(option.value)}
            className={`pulse-chip ${active ? "pulse-chip-active" : "pulse-chip-inactive"}`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
