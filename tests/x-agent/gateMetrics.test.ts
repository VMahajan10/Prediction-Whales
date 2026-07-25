import { describe, expect, it } from "vitest";
import {
  createGateSummary,
  recordCredibilityFailureBreakdown,
  recordGateMatrixFailures,
} from "@/lib/x-agent/gateMetrics";

describe("recordCredibilityFailureBreakdown", () => {
  it("counts not-in-registry when whale is missing", () => {
    const metrics = createGateSummary();
    recordCredibilityFailureBreakdown(metrics, null);

    expect(metrics.failedCredibility).toBe(1);
    expect(metrics.failedCredibility_NotInRegistry).toBe(1);
    expect(metrics.failedCredibility_ResolvedBets).toBe(0);
    expect(metrics.failedCredibility_AvgEv).toBe(0);
  });

  it("counts resolved bets and avg EV failures independently", () => {
    const metrics = createGateSummary();
    recordCredibilityFailureBreakdown(metrics, {
      resolvedBetsCount: 100,
      avgEv: 0.01,
    });

    expect(metrics.failedCredibility).toBe(1);
    expect(metrics.failedCredibility_NotInRegistry).toBe(0);
    expect(metrics.failedCredibility_ResolvedBets).toBe(1);
    expect(metrics.failedCredibility_AvgEv).toBe(1);
  });

  it("counts only avg EV when resolved bets meet threshold", () => {
    const metrics = createGateSummary();
    recordCredibilityFailureBreakdown(metrics, {
      resolvedBetsCount: 600,
      avgEv: 0.01,
    });

    expect(metrics.failedCredibility_ResolvedBets).toBe(0);
    expect(metrics.failedCredibility_AvgEv).toBe(1);
  });
});

describe("recordGateMatrixFailures", () => {
  it("delegates credibility breakdown to whale stats", () => {
    const metrics = createGateSummary();
    recordGateMatrixFailures(
      metrics,
      {
        passesEv: true,
        passesStake: true,
        passesCredibility: false,
        passesAlignment: true,
        passesFreshness: true,
        passesSource: true,
      },
      { resolvedBetsCount: 499, avgEv: 0.04 }
    );

    expect(metrics.failedCredibility).toBe(1);
    expect(metrics.failedCredibility_ResolvedBets).toBe(1);
    expect(metrics.failedCredibility_AvgEv).toBe(0);
  });
});
