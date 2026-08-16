import { describe, expect, it } from "vitest";
import type { PipelineTradeEv } from "@/lib/evPipeline/types";
import {
  isFullyComputedTradeEv,
  shouldBypassStaleEvCacheHit,
} from "@/lib/evPipeline/resolveTradeEv";
import { strictApiTradeEvPayload } from "@/lib/evPipeline/tradeEvRecord";

function staleMidZeroPayload(
  overrides: Partial<PipelineTradeEv> = {}
): PipelineTradeEv {
  return {
    key: "pm:test",
    status: "ok",
    tokenId: "abc",
    kalshiTicker: null,
    mappingPairKey: null,
    netEvPercent: 0,
    netEv: 0,
    grossEv: 0,
    grossEvPercent: 0,
    averageEv: 0,
    pTrue: 0.5,
    pMarket: 0.5,
    pmMid: 0.5,
    kalshiMid: null,
    pTrueSource: "standalone_ob",
    pTrueConfidence: 0.8,
    pTrueLowConfidence: false,
    evFormulaVersion: null,
    ...overrides,
  };
}

describe("shouldBypassStaleEvCacheHit", () => {
  it("bypasses mid-collapsed 0% when a whale fill price is present", () => {
    expect(
      shouldBypassStaleEvCacheHit(staleMidZeroPayload(), {
        executionPrice: 0.4,
      })
    ).toBe(true);
  });

  it("keeps true 0% when fair value matches the fill", () => {
    expect(
      shouldBypassStaleEvCacheHit(
        staleMidZeroPayload({ pTrue: 0.4, pMarket: 0.4, pmMid: 0.4 }),
        { executionPrice: 0.4 }
      )
    ).toBe(false);
  });
});

describe("isFullyComputedTradeEv", () => {
  it("rejects stale mid-based 0% even when execution price is present", () => {
    expect(
      isFullyComputedTradeEv(staleMidZeroPayload(), { executionPrice: 0.4 })
    ).toBe(false);
  });

  it("accepts repriced entry-anchored EV after strictApiTradeEvPayload", () => {
    const repriced = strictApiTradeEvPayload(staleMidZeroPayload(), "pm:test", {
      executionPrice: 0.4,
    });
    expect(
      isFullyComputedTradeEv(repriced, { executionPrice: 0.4 })
    ).toBe(true);
    expect(repriced.netEvPercent).toBeCloseTo(10, 0);
  });
});
