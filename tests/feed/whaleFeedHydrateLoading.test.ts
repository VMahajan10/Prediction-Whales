import { describe, expect, it, vi } from "vitest";
import { hydrateWhaleFeedSeed } from "@/lib/whaleFeed/hydrateWhaleFeedSeed";

describe("hydrateWhaleFeedSeed", () => {
  it("marks seed loaded after recent fetch even when /api/feed is still pending", async () => {
    let seedLoaded = false;
    let backfillResolved = false;

    const backfillGate = new Promise<void>((resolve) => {
      setTimeout(() => {
        backfillResolved = true;
        resolve();
      }, 50);
    });

    await hydrateWhaleFeedSeed({
      loadRecentSeed: async () => undefined,
      loadBackfill: async () => {
        await backfillGate;
      },
      markSeedLoaded: () => {
        seedLoaded = true;
      },
    });

    expect(seedLoaded).toBe(true);
    expect(backfillResolved).toBe(false);

    await backfillGate;
    expect(backfillResolved).toBe(true);
  });

  it("marks seed loaded when recent fetch fails but still kicks off backfill", async () => {
    const markSeedLoaded = vi.fn();
    const loadBackfill = vi.fn(async () => undefined);

    await hydrateWhaleFeedSeed({
      loadRecentSeed: async () => {
        throw new Error("recent timeout");
      },
      loadBackfill,
      markSeedLoaded,
    });

    expect(markSeedLoaded).toHaveBeenCalledTimes(1);
    expect(loadBackfill).toHaveBeenCalledTimes(1);
  });
});
