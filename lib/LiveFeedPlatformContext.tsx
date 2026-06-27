"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  getLiveFeedPlatform,
  setLiveFeedPlatform,
  type LiveFeedPlatform,
} from "@/lib/liveFeedPlatform";

interface LiveFeedPlatformContextValue {
  platform: LiveFeedPlatform;
  setPlatform: (platform: LiveFeedPlatform) => void;
}

const LiveFeedPlatformContext =
  createContext<LiveFeedPlatformContextValue | null>(null);

export function LiveFeedPlatformProvider({ children }: { children: ReactNode }) {
  const [platform, setPlatformState] = useState<LiveFeedPlatform>(() =>
    typeof window !== "undefined" ? getLiveFeedPlatform() : "all"
  );

  const setPlatform = useCallback((next: LiveFeedPlatform) => {
    setPlatformState(next);
    setLiveFeedPlatform(next);
  }, []);

  const value = useMemo(
    () => ({ platform, setPlatform }),
    [platform, setPlatform]
  );

  return (
    <LiveFeedPlatformContext.Provider value={value}>
      {children}
    </LiveFeedPlatformContext.Provider>
  );
}

export function useLiveFeedPlatform(): LiveFeedPlatformContextValue {
  const ctx = useContext(LiveFeedPlatformContext);
  if (!ctx) {
    throw new Error(
      "useLiveFeedPlatform must be used within LiveFeedPlatformProvider"
    );
  }
  return ctx;
}
