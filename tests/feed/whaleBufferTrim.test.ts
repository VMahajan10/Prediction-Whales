import { describe, expect, it } from "vitest";
import {
  KALSHI_BUFFER_FLOOR,
  trimFeedBufferWithVenueFloor,
} from "@/lib/feed/feedRetention";

/** Mirrors WHALE_FEED_LIVE_MAX in lib/useWhaleFeed.ts. */
const MAX = 50;

function trade(id: string, source: "polymarket" | "kalshi") {
  return { id, source };
}

describe("trimFeedBufferWithVenueFloor", () => {
  it("returns the buffer untouched when it is under the cap", () => {
    const buffer = [trade("a", "polymarket"), trade("b", "kalshi")];
    expect(trimFeedBufferWithVenueFloor(buffer, MAX)).toBe(buffer);
  });

  it("keeps a Kalshi floor when live Polymarket flow overflows the buffer", () => {
    // Live Polymarket trades always sort ahead of the older Kalshi backfill,
    // so a plain tail truncation would evict Kalshi entirely.
    const buffer = [
      ...Array.from({ length: MAX }, (_, i) => trade(`pm-${i}`, "polymarket")),
      ...Array.from({ length: 20 }, (_, i) => trade(`ks-${i}`, "kalshi")),
    ];

    const trimmed = trimFeedBufferWithVenueFloor(buffer, MAX);

    expect(trimmed).toHaveLength(MAX);
    expect(trimmed.filter((t) => t.source === "kalshi")).toHaveLength(
      KALSHI_BUFFER_FLOOR
    );
    expect(trimmed.filter((t) => t.source === "polymarket")).toHaveLength(
      MAX - KALSHI_BUFFER_FLOOR
    );
  });

  it("lets Kalshi use spare slots when Polymarket flow is thin", () => {
    const buffer = [
      ...Array.from({ length: 5 }, (_, i) => trade(`pm-${i}`, "polymarket")),
      ...Array.from({ length: MAX + 10 }, (_, i) => trade(`ks-${i}`, "kalshi")),
    ];

    const trimmed = trimFeedBufferWithVenueFloor(buffer, MAX);

    expect(trimmed).toHaveLength(MAX);
    expect(trimmed.filter((t) => t.source === "polymarket")).toHaveLength(5);
    expect(trimmed.filter((t) => t.source === "kalshi")).toHaveLength(MAX - 5);
  });

  it("gives every slot to Polymarket when there is no Kalshi flow", () => {
    const buffer = Array.from({ length: MAX + 25 }, (_, i) =>
      trade(`pm-${i}`, "polymarket")
    );

    const trimmed = trimFeedBufferWithVenueFloor(buffer, MAX);

    expect(trimmed).toHaveLength(MAX);
    expect(trimmed.every((t) => t.source === "polymarket")).toBe(true);
  });

  it("preserves the incoming order of retained trades", () => {
    const buffer = [
      ...Array.from({ length: MAX }, (_, i) => trade(`pm-${i}`, "polymarket")),
      ...Array.from({ length: 20 }, (_, i) => trade(`ks-${i}`, "kalshi")),
    ];

    const trimmed = trimFeedBufferWithVenueFloor(buffer, MAX);
    const positions = trimmed.map((t) => buffer.indexOf(t));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });
});
