export type LiveFeedPlatform = "all" | "polymarket" | "kalshi";

const STORAGE_KEY = "marketpulse:live-feed-platform";

type SessionStorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

function getSessionStorage(): SessionStorageLike | null {
  if (typeof globalThis === "undefined") return null;
  if (!("sessionStorage" in globalThis)) return null;

  const storage = (globalThis as { sessionStorage?: SessionStorageLike })
    .sessionStorage;
  return storage ?? null;
}

export function getLiveFeedPlatform(): LiveFeedPlatform {
  const storage = getSessionStorage();
  if (!storage) return "all";

  const value = storage.getItem(STORAGE_KEY);
  if (value === "polymarket" || value === "kalshi" || value === "all") {
    return value;
  }
  return "all";
}

export function setLiveFeedPlatform(platform: LiveFeedPlatform): void {
  const storage = getSessionStorage();
  if (!storage) return;

  storage.setItem(STORAGE_KEY, platform);
}

export const LIVE_FEED_PLATFORM_OPTIONS: {
  value: LiveFeedPlatform;
  label: string;
}[] = [
  { value: "all", label: "All" },
  { value: "polymarket", label: "Polymarket" },
  { value: "kalshi", label: "Kalshi" },
];
