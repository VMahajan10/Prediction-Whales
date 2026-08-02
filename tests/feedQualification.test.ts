import { describe, expect, it, vi, afterEach } from "vitest";
import {
  CREDIBILITY_CONFIG,
  isQualifiedFeedTrade,
  meetsFeedStakeThreshold,
  meetsFeedTieredStakeThreshold,
  meetsFeedTradeEvThreshold,
  meetsWalletAvgEvThreshold,
  MIN_AVG_EV_THRESHOLD,
  MIN_FEED_RESOLVED_BETS,
  MIN_FEED_TRADE_EV_PCT,
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

  it("enforces tiered stake floors by market category", () => {
    expect(
      meetsFeedTieredStakeThreshold({
        stakeUsd: 250,
        title: "Will the Lakers win the NBA Finals?",
      })
    ).toBe(true);
    expect(
      meetsFeedTieredStakeThreshold({
        stakeUsd: 249,
        title: "Will the Lakers win the NBA Finals?",
      })
    ).toBe(false);

    expect(
      meetsFeedTieredStakeThreshold({
        stakeUsd: 500,
        title: "Will Bitcoin reach $100k by end of year?",
      })
    ).toBe(true);
    expect(
      meetsFeedTieredStakeThreshold({
        stakeUsd: 499,
        title: "Will Bitcoin reach $100k by end of year?",
      })
    ).toBe(false);

    expect(
      meetsFeedTieredStakeThreshold({
        stakeUsd: 1000,
        title: "Will Trump win the 2028 presidential election?",
      })
    ).toBe(true);
    expect(
      meetsFeedTieredStakeThreshold({
        stakeUsd: 999,
        title: "Will Trump win the 2028 presidential election?",
      })
    ).toBe(false);
  });

  it("enforces the minimum trade EV threshold (+3.0%)", () => {
    expect(meetsFeedTradeEvThreshold(MIN_FEED_TRADE_EV_PCT)).toBe(true);
    expect(meetsFeedTradeEvThreshold(MIN_FEED_TRADE_EV_PCT - 0.1)).toBe(
      false
    );
    expect(meetsFeedTradeEvThreshold(-14)).toBe(false);
    expect(meetsFeedTradeEvThreshold(null)).toBe(false);
  });

  it("enforces the minimum wallet avg EV threshold", () => {
    expect(meetsWalletAvgEvThreshold(MIN_AVG_EV_THRESHOLD)).toBe(true);
    expect(meetsWalletAvgEvThreshold(MIN_AVG_EV_THRESHOLD - 0.001)).toBe(
      false
    );
    expect(meetsWalletAvgEvThreshold(-0.001)).toBe(false);
  });

  it("requires stake, wallet avg EV, resolved bets, and trade EV for feed qualification", () => {
    expect(CREDIBILITY_CONFIG.MIN_RESOLVED_BETS).toBe(100);

    const qualifiedBase = {
      stakeUsd: 500,
      walletAvgEv: MIN_AVG_EV_THRESHOLD,
      resolvedBetCount: MIN_FEED_RESOLVED_BETS,
      title: "Will Bitcoin reach $100k?",
      tradeEvPercent: MIN_FEED_TRADE_EV_PCT,
    };

    expect(isQualifiedFeedTrade(qualifiedBase)).toBe(true);

    expect(
      isQualifiedFeedTrade({
        ...qualifiedBase,
        walletAvgEv: -0.011,
      })
    ).toBe(false);

    expect(
      isQualifiedFeedTrade({
        ...qualifiedBase,
        stakeUsd: 499,
      })
    ).toBe(false);

    expect(
      isQualifiedFeedTrade({
        ...qualifiedBase,
        resolvedBetCount: MIN_FEED_RESOLVED_BETS - 1,
      })
    ).toBe(false);

    expect(
      isQualifiedFeedTrade({
        ...qualifiedBase,
        walletAvgEv: null,
      })
    ).toBe(false);

    expect(
      isQualifiedFeedTrade({
        ...qualifiedBase,
        tradeEvPercent: 2.9,
      })
    ).toBe(false);

    expect(
      isQualifiedFeedTrade({
        ...qualifiedBase,
        tradeEvPercent: -14,
      })
    ).toBe(false);

    expect(
      isQualifiedFeedTrade({
        stakeUsd: 250,
        walletAvgEv: MIN_AVG_EV_THRESHOLD,
        resolvedBetCount: 400,
        title: "Will the Lakers win the NBA Finals?",
        tradeEvPercent: MIN_FEED_TRADE_EV_PCT,
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
