import { describe, expect, it } from "vitest";
import { resolveFeedTradeEvDisplay } from "@/lib/feedTradeEv";

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

  it("formats negative EV in red tone", () => {
    const display = resolveFeedTradeEvDisplay({
      price: 0.42,
      source: "kalshi",
      netEvPercent: -3.2,
    });

    expect(display.value).toBe("-3.2% EV");
    expect(display.positive).toBe(false);
    expect(display.negative).toBe(true);
  });

  it("shows market-price label for zero Kalshi EV", () => {
    const display = resolveFeedTradeEvDisplay({
      price: 0.42,
      source: "kalshi",
      netEvPercent: 0,
    });

    expect(display.label).toBe("TRADE EV");
    expect(display.value).toBe("+0.0% EV");
    expect(display.sublabel).toBe("Market Price");
  });

  it("uses price edge when live now price differs from entry", () => {
    const display = resolveFeedTradeEvDisplay({
      price: 0.4,
      nowPrice: 0.5,
      isBuy: true,
      source: "kalshi",
      netEvPercent: null,
    });

    expect(display.label).toBe("TRADE EV");
    expect(display.value).toBe("+25.0% EV");
    expect(display.positive).toBe(true);
  });

  it("shows implied probability (not EV) when model EV is unknown", () => {
    const display = resolveFeedTradeEvDisplay({
      price: 0.42,
      source: "kalshi",
      netEvPercent: null,
    });

    expect(display.label).toBe("IMPLIED PROB");
    expect(display.value).toBe("42.0%");
    expect(display.sublabel).toBe("AT ENTRY");
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
