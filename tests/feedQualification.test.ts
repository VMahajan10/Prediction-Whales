import { describe, expect, it, vi, afterEach } from "vitest";
import {
  CREDIBILITY_CONFIG,
  isQualifiedFeedTrade,
  meetsFeedStakeThreshold,
  meetsWalletAvgEvThreshold,
  MIN_AVG_EV_THRESHOLD,
  MIN_FEED_RESOLVED_BETS,
  MIN_STAKE_THRESHOLD,
} from "@/lib/feedQualification";
import {
  logFeedMetricsSummary,
  recordFeedMetrics,
  resetFeedMetricsForTests,
} from "@/lib/feedMetrics";

describe("feedQualification", () => {
  it("enforces the minimum stake threshold", () => {
    expect(meetsFeedStakeThreshold(MIN_STAKE_THRESHOLD)).toBe(true);
    expect(meetsFeedStakeThreshold(MIN_STAKE_THRESHOLD - 1)).toBe(false);
  });

  it("enforces the minimum wallet avg EV threshold", () => {
    expect(meetsWalletAvgEvThreshold(MIN_AVG_EV_THRESHOLD)).toBe(true);
    expect(meetsWalletAvgEvThreshold(MIN_AVG_EV_THRESHOLD - 0.001)).toBe(
      false
    );
    expect(meetsWalletAvgEvThreshold(-0.001)).toBe(false);
  });

  it("requires stake, wallet avg EV, and resolved bets for feed qualification", () => {
    expect(CREDIBILITY_CONFIG.MIN_RESOLVED_BETS).toBe(300);

    expect(
      isQualifiedFeedTrade({
        stakeUsd: MIN_STAKE_THRESHOLD,
        walletAvgEv: -0.011,
        resolvedBetCount: 400,
      })
    ).toBe(false);

    expect(
      isQualifiedFeedTrade({
        stakeUsd: MIN_STAKE_THRESHOLD - 1,
        walletAvgEv: MIN_AVG_EV_THRESHOLD,
        resolvedBetCount: MIN_FEED_RESOLVED_BETS,
      })
    ).toBe(false);

    expect(
      isQualifiedFeedTrade({
        stakeUsd: MIN_STAKE_THRESHOLD,
        walletAvgEv: MIN_AVG_EV_THRESHOLD,
        resolvedBetCount: MIN_FEED_RESOLVED_BETS - 1,
      })
    ).toBe(false);

    expect(
      isQualifiedFeedTrade({
        stakeUsd: MIN_STAKE_THRESHOLD,
        walletAvgEv: null,
        resolvedBetCount: 400,
      })
    ).toBe(false);

    expect(
      isQualifiedFeedTrade({
        stakeUsd: MIN_STAKE_THRESHOLD,
        walletAvgEv: MIN_AVG_EV_THRESHOLD,
        resolvedBetCount: MIN_FEED_RESOLVED_BETS,
      })
    ).toBe(true);
  });
});

describe("feedMetrics", () => {
  afterEach(() => {
    resetFeedMetricsForTests();
    vi.restoreAllMocks();
  });

  it("logs daily feed metrics with detected, passed, and distinct whales", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    recordFeedMetrics({
      tradesDetected: 12,
      gatePassedTrades: 3,
      whaleWallets: ["0xabc", "0xdef", "0xabc"],
    });

    expect(logSpy).toHaveBeenCalled();
    const line = String(logSpy.mock.calls.at(-1)?.[0]);
    expect(line).toContain("[FeedMetrics]");
    expect(line).toContain("tradesDetected=12");
    expect(line).toContain("gatePassedTrades=3");
    expect(line).toContain("distinctWhales=2");

    logFeedMetricsSummary({
      dayKey: "2026-07-31",
      tradesDetected: 5,
      gatePassedTrades: 2,
      distinctWhales: new Set(["0x1"]),
    });
    expect(String(logSpy.mock.calls.at(-1)?.[0])).toContain("distinctWhales=1");
  });
});
