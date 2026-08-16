import { describe, expect, it } from "vitest";
import {
  entryPriceEvPercent,
  passesFeedTradeEvGate,
  coalesceTradeEvPercent,
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

  it("uses pipeline EV when trade row carries stale zero EV", () => {
    const display = resolveFeedTradeEvDisplay(
      {
        price: 0.4,
        source: "polymarket",
        netEvPercent: 0,
        averageEv: 0,
      },
      {
        key: "pm:1",
        status: "ok",
        netEvPercent: 0,
        grossEvPercent: null,
        averageEv: 0,
        pTrue: 0.5,
        pMarket: 0.5,
        pmMid: 0.5,
        pTrueLowConfidence: false,
        pTrueSource: "cached_ensemble",
      } as import("@/lib/evPipeline/types").PipelineTradeEv
    );

    expect(display.value).toBe("+25.0% EV");
  });
});

describe("coalesceTradeEvPercent", () => {
  it("prefers netEvPercent and alternate API field names", () => {
    expect(
      coalesceTradeEvPercent({
        netEvPercent: 5.8,
        averageEv: 3.1,
        ev: 0.02,
      })
    ).toBe(5.8);

    expect(
      coalesceTradeEvPercent({
        evPercent: 4.2,
      })
    ).toBe(4.2);

    expect(
      coalesceTradeEvPercent({
        ev: 0.058,
      })
    ).toBeCloseTo(5.8, 5);
  });

  it("returns null when no EV fields are present", () => {
    expect(coalesceTradeEvPercent({})).toBeNull();
    expect(coalesceTradeEvPercent(null)).toBeNull();
  });
});
