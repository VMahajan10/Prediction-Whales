import { describe, expect, it } from "vitest";
import { resolveFeedTradeEvDisplay } from "@/lib/feedTradeEv";

describe("resolveFeedTradeEvDisplay", () => {
  it("shows market-price label for zero Kalshi EV", () => {
    const display = resolveFeedTradeEvDisplay({
      price: 0.42,
      source: "kalshi",
      netEvPercent: 0,
    });

    expect(display.value).toBe("0.0%");
    expect(display.sublabel).toBe("Market Price");
  });

  it("shows implied probability when Kalshi EV is unknown", () => {
    const display = resolveFeedTradeEvDisplay({
      price: 0.42,
      source: "kalshi",
      netEvPercent: null,
    });

    expect(display.value).toBe("Implied: 42.0%");
  });

  it("keeps N/A for Polymarket when EV is unknown", () => {
    const display = resolveFeedTradeEvDisplay({
      price: 0.42,
      source: "polymarket",
      netEvPercent: null,
    });

    expect(display.value).toBe("N/A");
  });
});
