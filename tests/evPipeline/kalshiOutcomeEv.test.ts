import { describe, expect, it } from "vitest";
import {
  kalshiMidForOutcome,
  normalizeKalshiOutcomeSide,
  pipelineFairMidsForKalshiOutcome,
} from "@/lib/evPipeline/kalshiOutcomeEv";
import { resolveKalshiContractEvFallback } from "@/lib/feed/kalshiFeedTrades";
import type { PipelineTradeEv } from "@/lib/evPipeline/types";

describe("kalshiOutcomeEv", () => {
  it("converts YES mids to NO outcome space", () => {
    expect(kalshiMidForOutcome(0.6, "no")).toBeCloseTo(0.4, 6);
    expect(kalshiMidForOutcome(0.6, "yes")).toBeCloseTo(0.6, 6);
  });

  it("normalizes outcome labels", () => {
    expect(normalizeKalshiOutcomeSide("No")).toBe("no");
    expect(normalizeKalshiOutcomeSide("Yes")).toBe("yes");
  });

  it("re-expresses pipeline mids for NO contracts", () => {
    const fair = pipelineFairMidsForKalshiOutcome(
      { pmMid: 0.6, kalshiMid: 0.55, pTrue: 0.58 },
      "no"
    );
    expect(fair.pmMid).toBeCloseTo(0.4, 6);
    expect(fair.kalshiMid).toBeCloseTo(0.45, 6);
    expect(fair.pTrue).toBeCloseTo(0.42, 6);
  });
});

describe("resolveKalshiContractEvFallback outcome space", () => {
  it("uses PM YES mid against NO entry when outcome is No", () => {
    const ev = resolveKalshiContractEvFallback(
      0.35,
      {
        status: "unmapped",
        pmMid: 0.6,
        kalshiMid: null,
      } as PipelineTradeEv,
      "No"
    );
    // fair NO ≈ 0.4 vs entry 0.35 → ~14.3% ROI
    expect(ev).toBeCloseTo(14.2857, 2);
  });
});
