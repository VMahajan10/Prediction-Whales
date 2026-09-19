import { describe, expect, it } from "vitest";
import {
  evaluateIndexedCredibilityCandidateV2,
  performanceVerdictFromPolicy,
} from "@/lib/walletLedger/indexed/credibilityCandidateV2";

describe("credibilityCandidateV2", () => {
  it("returns overall UNKNOWN when performance unresolved", () => {
    const result = evaluateIndexedCredibilityCandidateV2({
      indexedDataValidity: true,
      completedPositionCount: 12,
    });
    expect(result.dataValidity).toBe("PASS");
    expect(result.historicalEvidence).toBe("PASS");
    expect(result.historicalPerformance).toBe("UNKNOWN");
    expect(result.capitalQualification).toBe("NOT_USED");
    expect(result.overallDecision).toBe("UNKNOWN");
  });

  it("fails overall when data validity fails", () => {
    const result = evaluateIndexedCredibilityCandidateV2({
      indexedDataValidity: false,
      completedPositionCount: 20,
    });
    expect(result.overallDecision).toBe("FAIL");
  });

  it("can pass overall only when performance explicitly passes", () => {
    const result = evaluateIndexedCredibilityCandidateV2(
      {
        indexedDataValidity: true,
        completedPositionCount: 15,
      },
      { historicalPerformance: "PASS" }
    );
    expect(result.overallDecision).toBe("PASS");
  });

  it("evaluates exploratory ROI policy", () => {
    expect(
      performanceVerdictFromPolicy({
        portfolioRealizedRoi: 0.05,
        profitablePositionRate: 0.2,
        policy: { kind: "roi_gte", threshold: 0.03, label: "test" },
      })
    ).toBe("PASS");
  });
});
