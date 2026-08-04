import { describe, expect, it, vi, afterEach } from "vitest";
import {
  CREDIBILITY_CONFIG,
  isQualifiedCredentialedFeedTrade,
  isQualifiedFeedTrade,
  isQualifiedLiveFeedTrade,
  meetsFeedStakeThreshold,
  meetsFeedTieredStakeThreshold,
  meetsFeedTradeEvThreshold,
  meetsProductFeedStakeThreshold,
  meetsWalletAvgEvThreshold,
  MIN_AVG_EV_THRESHOLD,
  MIN_FEED_RESOLVED_BETS,
  MIN_FEED_TRADE_EV_DECIMAL,
  MIN_FEED_TRADE_EV_PCT,
  MIN_PRODUCT_FEED_STAKE_USD,
  MIN_STAKE_THRESHOLD,
  resolvePolymarketTradeNotionalUsd,
} from "@/lib/feedQualification";
import {
  evaluateLiveFeedTradeGate,
  passesLiveFeedTradeGate,
} from "@/lib/feedGate";
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

  it("enforces the flat product feed stake floor ($500)", () => {
    expect(meetsProductFeedStakeThreshold(MIN_PRODUCT_FEED_STAKE_USD)).toBe(
      true
    );
    expect(
      meetsProductFeedStakeThreshold(MIN_PRODUCT_FEED_STAKE_USD - 1)
    ).toBe(false);
    expect(
      meetsProductFeedStakeThreshold(250)
    ).toBe(false);
  });

  it("enforces tiered stake floors for post-queue style checks", () => {
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
        stakeUsd: 250,
        category: "ESPORTS",
      })
    ).toBe(true);

    expect(
      meetsFeedTieredStakeThreshold({
        stakeUsd: 250,
        category: "gaming",
      })
    ).toBe(true);

    expect(
      meetsFeedTieredStakeThreshold({
        stakeUsd: 250,
        category: "SPORTS",
      })
    ).toBe(true);

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

  it("product feed gate requires flat $500 stake and trade EV", () => {
    expect(
      isQualifiedLiveFeedTrade({
        stakeUsd: 500,
        title: "Will Bitcoin reach $100k?",
        tradeEvPercent: MIN_FEED_TRADE_EV_PCT,
      })
    ).toBe(true);

    expect(
      isQualifiedLiveFeedTrade({
        stakeUsd: 500,
        title: "Will Bitcoin reach $100k?",
        tradeEvPercent: 2.9,
      })
    ).toBe(false);

    expect(
      isQualifiedLiveFeedTrade({
        stakeUsd: 499,
        title: "Will Bitcoin reach $100k?",
        tradeEvPercent: 9,
      })
    ).toBe(false);
  });

  it("credentialed feed gate still requires wallet history", () => {
    const qualifiedBase = {
      stakeUsd: 500,
      walletAvgEv: MIN_AVG_EV_THRESHOLD,
      resolvedBetCount: MIN_FEED_RESOLVED_BETS,
      title: "Will Bitcoin reach $100k?",
      tradeEvPercent: MIN_FEED_TRADE_EV_PCT,
    };

    expect(isQualifiedCredentialedFeedTrade(qualifiedBase)).toBe(true);
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
      isQualifiedCredentialedFeedTrade({
        stakeUsd: 250,
        walletAvgEv: MIN_AVG_EV_THRESHOLD,
        resolvedBetCount: 400,
        title: "Will the Lakers win the NBA Finals?",
        tradeEvPercent: MIN_FEED_TRADE_EV_PCT,
      })
    ).toBe(true);
  });
});

describe("feedGate", () => {
  it("rejects trades below calculatedEv floor with explicit debug fields", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const result = evaluateLiveFeedTradeGate(
      {
        stakeUsd: 600,
        title: "Will Bitcoin reach $100k?",
        tradeEvPercent: 2.5,
      },
      { id: "trade-1", source: "api" }
    );

    expect(result.passed).toBe(false);
    expect(result.reason).toBe("trade_ev");
    expect(result.calculatedEvPercent).toBe(2.5);
    expect(result.requiredEvPercent).toBe(MIN_FEED_TRADE_EV_PCT);
    expect(result.requiredEvDecimal).toBe(MIN_FEED_TRADE_EV_DECIMAL);

    const line = String(logSpy.mock.calls.at(-1)?.[0]);
    expect(line).toContain("[Feed Gate Reject]");
    expect(line).toContain("calculatedEv=2.5%");
    expect(line).toContain("stake=$600.00");
    expect(line).toContain(`requiredEv>=${MIN_FEED_TRADE_EV_PCT}%`);
    expect(line).toContain("reason=trade_ev");
  });

  it("rejects trades below stake/notional floor", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const result = evaluateLiveFeedTradeGate(
      {
        stakeUsd: 300,
        title: "Will Bitcoin reach $100k?",
        tradeEvPercent: 5,
      },
      { id: "trade-2", source: "socket" }
    );

    expect(result.passed).toBe(false);
    expect(result.reason).toBe("stake_floor");
    expect(result.requiredStakeFloorUsd).toBe(500);

    const line = String(logSpy.mock.calls.at(-1)?.[0]);
    expect(line).toContain("reason=stake_floor");
    expect(line).toContain("requiredStake>=$500.00");
    logSpy.mockRestore();
  });

  it("computes Polymarket REST notional as price × size", () => {
    expect(
      resolvePolymarketTradeNotionalUsd({ price: 0.5, size: 1000 })
    ).toBe(500);
    expect(passesLiveFeedTradeGate({
      stakeUsd: 500,
      title: "Will Bitcoin reach $100k?",
      tradeEvPercent: MIN_FEED_TRADE_EV_PCT,
    }, { logRejection: false })).toBe(true);
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
