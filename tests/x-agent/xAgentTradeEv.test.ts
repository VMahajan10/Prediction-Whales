import { describe, expect, it } from "vitest";
import type { PipelineTradeEv } from "@/lib/evPipeline/types";
import {
  meetsXAgentTradeEvGate,
  resolveXAgentQueueEvPercent,
} from "@/lib/x-agent/xAgentTradeEv";

function pipeline(
  overrides: Partial<PipelineTradeEv> = {}
): PipelineTradeEv {
  return {
    key: "test",
    status: "ok",
    tokenId: null,
    kalshiTicker: null,
    mappingPairKey: null,
    netEvPercent: null,
    netEv: 0,
    grossEv: 0,
    grossEvPercent: null,
    averageEv: null,
    pTrue: 0.5,
    pMarket: 0.5,
    pmMid: null,
    kalshiMid: null,
    pTrueSource: null,
    pTrueConfidence: null,
    pTrueLowConfidence: false,
    evFormulaVersion: null,
    ...overrides,
  };
}

describe("resolveXAgentQueueEvPercent", () => {
  it("passes +2.4% EV at default 0% floor without stake tiers", () => {
    expect(
      resolveXAgentQueueEvPercent(pipeline({ netEvPercent: 2.4 }), 600)
    ).toBe(2.4);
    expect(meetsXAgentTradeEvGate(2.4, 600)).toBe(true);
  });

  it("neutralizes small negative EV for stakes >= $1,000", () => {
    expect(
      resolveXAgentQueueEvPercent(pipeline({ netEvPercent: -0.5 }), 2_000)
    ).toBe(0);
    expect(meetsXAgentTradeEvGate(0, 9_600)).toBe(true);
    expect(meetsXAgentTradeEvGate(-0.5, 9_600)).toBe(true);
  });

  it("neutralizes timeout payloads for whale stakes", () => {
    expect(
      resolveXAgentQueueEvPercent(
        pipeline({ status: "timeout", netEvPercent: null }),
        2_000
      )
    ).toBe(0);
  });

  it("bypasses EV gate for stakes >= $5,000", () => {
    expect(meetsXAgentTradeEvGate(null, 5_000)).toBe(true);
    expect(meetsXAgentTradeEvGate(-1, 5_000)).toBe(true);
  });
});
