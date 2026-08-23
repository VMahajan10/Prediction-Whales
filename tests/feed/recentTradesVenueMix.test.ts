import { describe, expect, it } from "vitest";
import {
  combineRecentTrades,
  VENUE_SLOT_FLOOR,
  type RecentFeedTrade,
} from "@/lib/feed/recentTradesServer";
import { filterFeedByPlatform } from "@/lib/liveFeedMerge";

function polymarketTrade(index: number, timestamp: number): RecentFeedTrade {
  return {
    id: `pm-${index}`,
    source: "polymarket",
    title: `Polymarket market ${index}`,
    outcome: "Yes",
    side: "BUY",
    price: 0.4,
    size: 2000,
    usdNotional: 800,
    timestamp,
    traceable: true,
    transactionHash: `0xpm${index}`,
    netEvPercent: 5,
  };
}

function kalshiTrade(index: number, timestamp: number): RecentFeedTrade {
  return {
    id: `kalshi-${index}`,
    source: "kalshi",
    title: `Kalshi market ${index}`,
    outcome: "Yes",
    side: "BUY",
    price: 0.4,
    size: 2000,
    usdNotional: 800,
    timestamp,
    traceable: true,
    ticker: `KX-${index}`,
    netEvPercent: 5,
  };
}

const NOW = 1_800_000_000;
const FOUR_DAYS_SEC = 4 * 24 * 60 * 60;

describe("combineRecentTrades", () => {
  it("keeps older Kalshi trades when every Polymarket row is newer", () => {
    // Reproduces the production shape: dense same-day Polymarket flow plus
    // Kalshi rows that are days older but still qualifying.
    const polymarket = Array.from({ length: 50 }, (_, i) =>
      polymarketTrade(i, NOW - i)
    );
    const kalshi = Array.from({ length: 45 }, (_, i) =>
      kalshiTrade(i, NOW - FOUR_DAYS_SEC - i)
    );

    const combined = combineRecentTrades(polymarket, kalshi, 50);

    expect(combined).toHaveLength(50);
    const kalshiCount = combined.filter((t) => t.source === "kalshi").length;
    expect(kalshiCount).toBe(VENUE_SLOT_FLOOR);
    expect(combined.filter((t) => t.source === "polymarket")).toHaveLength(
      50 - VENUE_SLOT_FLOOR
    );
  });

  it("orders the merged list newest first", () => {
    const combined = combineRecentTrades(
      Array.from({ length: 30 }, (_, i) => polymarketTrade(i, NOW - i)),
      Array.from({ length: 30 }, (_, i) =>
        kalshiTrade(i, NOW - FOUR_DAYS_SEC - i)
      ),
      50
    );

    const timestamps = combined.map((trade) => trade.timestamp);
    expect(timestamps).toEqual([...timestamps].sort((a, b) => b - a));
  });

  it("gives every slot to Polymarket when there is no Kalshi flow", () => {
    const combined = combineRecentTrades(
      Array.from({ length: 60 }, (_, i) => polymarketTrade(i, NOW - i)),
      [],
      50
    );

    expect(combined).toHaveLength(50);
    expect(combined.every((trade) => trade.source === "polymarket")).toBe(true);
  });

  it("gives every slot to Kalshi when there is no Polymarket flow", () => {
    const combined = combineRecentTrades(
      [],
      Array.from({ length: 60 }, (_, i) => kalshiTrade(i, NOW - i)),
      50
    );

    expect(combined).toHaveLength(50);
    expect(combined.every((trade) => trade.source === "kalshi")).toBe(true);
  });

  it("dedupes repeated Kalshi trade ids", () => {
    const duplicate = kalshiTrade(1, NOW);
    const combined = combineRecentTrades([], [duplicate, { ...duplicate }], 50);
    expect(combined).toHaveLength(1);
  });
});

describe("platform filter casing", () => {
  it("matches Kalshi rows tagged with an uppercase platform", () => {
    const rows = [
      { source: "kalshi", platform: "KALSHI" },
      { source: "polymarket", platform: "POLYMARKET" },
    ];

    expect(filterFeedByPlatform(rows, "kalshi")).toEqual([
      { source: "kalshi", platform: "KALSHI" },
    ]);
    expect(filterFeedByPlatform(rows, "polymarket")).toEqual([
      { source: "polymarket", platform: "POLYMARKET" },
    ]);
    expect(filterFeedByPlatform(rows, "all")).toHaveLength(2);
  });

  it("falls back to source when no platform tag is present", () => {
    const rows = [{ source: "kalshi" }, { source: "polymarket" }];
    expect(filterFeedByPlatform(rows, "kalshi")).toEqual([{ source: "kalshi" }]);
  });
});
