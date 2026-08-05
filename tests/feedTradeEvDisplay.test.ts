import { describe, expect, it } from "vitest";
import {
  entryPriceEvPercent,
  passesFeedTradeEvGate,
  resolveFeedTradeEvDisplay,
} from "@/lib/feedTradeEv";

describe("entryPriceEvPercent", () => {
  it("uses ((fair - entry) / entry) × 100", () => {
    expect(entryPriceEvPercent(0.5, 0.4)).toBeCloseTo(25, 5);
    expect(entryPriceEvPercent(0.35, 0.5)).toBeCloseTo(-30, 5);
  });
});

describe("passesFeedTradeEvGate", () => {
  it("requires finite EV >= +3.0%", () => {
    expect(passesFeedTradeEvGate(3)).toBe(true);
    expect(passesFeedTradeEvGate(2.9)).toBe(false);
    expect(passesFeedTradeEvGate(null)).toBe(false);
    expect(passesFeedTradeEvGate(undefined)).toBe(false);
  });
});

describe("resolveFeedTradeEvDisplay", () => {
  it("formats known EV with sign and EV suffix", () => {
    const display = resolveFeedTradeEvDisplay({
      price: 0.42,
      source: "kalshi",
      netEvPercent: 2.4,
    });

    expect(display.label).toBe("TRADE EV");
    expect(display.value).toBe("+2.4% EV");
    expect(display.positive).toBe(true);
    expect(display.negative).toBe(false);
  });

  it("formats negative EV", () => {
    const display = resolveFeedTradeEvDisplay({
      price: 0.42,
      source: "kalshi",
      netEvPercent: -3.2,
    });

    expect(display.value).toBe("-3.2% EV");
    expect(display.positive).toBe(false);
    expect(display.negative).toBe(true);
  });

  it("never shows implied probability as EV", () => {
    const display = resolveFeedTradeEvDisplay({
      price: 0.91,
      source: "kalshi",
      netEvPercent: null,
    });

    expect(display.label).toBe("TRADE EV");
    expect(display.value).toBe("N/A");
    expect(display.value).not.toContain("Implied");
  });

  it("keeps N/A for Polymarket when EV is unknown", () => {
    const display = resolveFeedTradeEvDisplay({
      price: 0.42,
      source: "polymarket",
      netEvPercent: null,
    });

    expect(display.label).toBe("TRADE EV");
    expect(display.value).toBe("N/A");
  });
});
