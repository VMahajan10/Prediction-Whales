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
  it("passes pipeline EV through unchanged", () => {
    expect(resolveXAgentQueueEvPercent(pipeline({ netEvPercent: 2.4 }))).toBe(
      2.4
    );
    expect(resolveXAgentQueueEvPercent(pipeline({ netEvPercent: 4.2 }))).toBe(
      4.2
    );
  });

  it("rejects negative EV without neutralization", () => {
    expect(
      resolveXAgentQueueEvPercent(pipeline({ netEvPercent: -0.6 }))
    ).toBe(-0.6);
    expect(meetsXAgentTradeEvGate(-0.6)).toBe(false);
    expect(meetsXAgentTradeEvGate(0)).toBe(false);
  });

  it("returns null for timeout payloads so the EV gate drops the trade", () => {
    expect(
      resolveXAgentQueueEvPercent(
        pipeline({ status: "timeout", netEvPercent: null })
      )
    ).toBeNull();
    expect(meetsXAgentTradeEvGate(null)).toBe(false);
  });

  it("requires at least +3.0% EV to pass", () => {
    expect(meetsXAgentTradeEvGate(2.9)).toBe(false);
    expect(meetsXAgentTradeEvGate(2.4)).toBe(false);
    expect(meetsXAgentTradeEvGate(3.0)).toBe(true);
    expect(meetsXAgentTradeEvGate(4.2)).toBe(true);
  });
});
