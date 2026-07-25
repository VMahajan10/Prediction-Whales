import { describe, expect, it } from "vitest";
import {
  createGateSummary,
  MIN_WALLET_RESOLVED_BETS,
  RollingGateMatrixTracker,
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
      resolvedBetsCount: MIN_WALLET_RESOLVED_BETS - 1,
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
      { resolvedBetsCount: MIN_WALLET_RESOLVED_BETS - 1, avgEv: 0.04 }
    );

    expect(metrics.failedCredibility).toBe(1);
    expect(metrics.failedCredibility_ResolvedBets).toBe(1);
    expect(metrics.failedCredibility_AvgEv).toBe(0);
  });
});

describe("RollingGateMatrixTracker", () => {
  it("aggregates rolling gate metrics across trades", () => {
    const rolling = new RollingGateMatrixTracker(2);

    rolling.recordTradeEvaluated();
    rolling.recordGateMatrixFailures(
      {
        passesEv: false,
        passesStake: true,
        passesCredibility: true,
        passesAlignment: true,
        passesFreshness: true,
        passesSource: true,
      },
      { resolvedBetsCount: 200, avgEv: 0.05 }
    );
    rolling.finalizeTrade();

    rolling.recordTradeEvaluated();
    rolling.recordGateMatrixFailures(
      {
        passesEv: true,
        passesStake: false,
        passesCredibility: true,
        passesAlignment: true,
        passesFreshness: true,
        passesSource: true,
      },
      { resolvedBetsCount: 200, avgEv: 0.05 }
    );
    rolling.recordQueuedSuccess();
    rolling.finalizeTrade();

    rolling.recordTradeEvaluated();
    rolling.recordGateMatrixFailures(
      {
        passesEv: true,
        passesStake: true,
        passesCredibility: false,
        passesAlignment: true,
        passesFreshness: true,
        passesSource: true,
      },
      { resolvedBetsCount: 10, avgEv: 0.01 }
    );
    rolling.finalizeTrade();

    const summary = rolling.aggregate();
    expect(summary.totalEvaluated).toBe(2);
    expect(summary.failedEvThreshold).toBe(0);
    expect(summary.failedStakeFloor).toBe(1);
    expect(summary.failedCredibility).toBe(1);
    expect(summary.queuedSuccessfully).toBe(1);
    expect(rolling.getWindowSize()).toBe(2);
  });
});
