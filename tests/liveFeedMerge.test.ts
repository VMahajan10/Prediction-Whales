import { describe, expect, it } from "vitest";
import { filterFeedByPlatform, normalizeFeedPlatform } from "@/lib/liveFeedMerge";

describe("normalizeFeedPlatform", () => {
  it("normalizes uppercase platform tags", () => {
    expect(normalizeFeedPlatform({ platform: "POLYMARKET" })).toBe("polymarket");
    expect(normalizeFeedPlatform({ platform: "KALSHI" })).toBe("kalshi");
  });

  it("falls back to source when platform is missing", () => {
    expect(normalizeFeedPlatform({ source: "polymarket" })).toBe("polymarket");
    expect(normalizeFeedPlatform({ source: "kalshi" })).toBe("kalshi");
  });

  it("returns null for unknown or missing rows", () => {
    expect(normalizeFeedPlatform(null)).toBeNull();
    expect(normalizeFeedPlatform(undefined)).toBeNull();
    expect(normalizeFeedPlatform({})).toBeNull();
  });
});

describe("filterFeedByPlatform", () => {
  it("handles empty input safely", () => {
    expect(filterFeedByPlatform([], "polymarket")).toEqual([]);
  });

  it("filters by platform case-insensitively", () => {
    const rows = [
      { source: "polymarket" as const },
      { platform: "KALSHI" },
      { source: "kalshi" as const },
    ];

    expect(filterFeedByPlatform(rows, "kalshi")).toHaveLength(2);
    expect(filterFeedByPlatform(rows, "polymarket")).toHaveLength(1);
    expect(filterFeedByPlatform(rows, "all")).toHaveLength(3);
  });
});
