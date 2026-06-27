export type LiveFeedPlatform = "all" | "polymarket" | "kalshi";

const STORAGE_KEY = "marketpulse:live-feed-platform";

export function getLiveFeedPlatform(): LiveFeedPlatform {
  if (typeof window === "undefined") return "all";
  const value = sessionStorage.getItem(STORAGE_KEY);
  if (value === "polymarket" || value === "kalshi" || value === "all") {
    return value;
  }
  return "all";
}

export function setLiveFeedPlatform(platform: LiveFeedPlatform): void {
  if (typeof window === "undefined") return;
  sessionStorage.setItem(STORAGE_KEY, platform);
}

export const LIVE_FEED_PLATFORM_OPTIONS: {
  value: LiveFeedPlatform;
  label: string;
}[] = [
  { value: "all", label: "All" },
  { value: "polymarket", label: "Polymarket" },
  { value: "kalshi", label: "Kalshi" },
];
