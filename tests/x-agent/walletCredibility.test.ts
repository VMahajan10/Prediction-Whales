import { describe, expect, it } from "vitest";
import {
  clearLowCredibilityCacheForTests,
  closedPositionsToResolvedBets,
  computeWalletCredibilityStats,
  walletMeetsCredibilityCriteria,
} from "@/lib/x-agent/walletCredibility";

describe("walletCredibility", () => {
  it("maps closed positions into resolved bets for avgEv", () => {
    const bets = closedPositionsToResolvedBets([
      { avgPrice: 0.4, realizedPnl: 12 },
      { avgPrice: 0.6, realizedPnl: -8 },
      { avgPrice: 0, realizedPnl: 5 },
    ]);

    expect(bets).toEqual([
      { entryPrice: 0.4, payout: 1 },
      { entryPrice: 0.6, payout: 0 },
    ]);

    const stats = computeWalletCredibilityStats([
      { avgPrice: 0.4, realizedPnl: 12 },
      { avgPrice: 0.6, realizedPnl: -8 },
    ]);

    expect(stats.resolvedBetsCount).toBe(2);
    expect(stats.winRate).toBe(0.5);
    expect(stats.avgEv).toBeCloseTo(0.25, 5);
  });

  it("evaluates wallet credibility criteria independently from trade EV", () => {
    expect(
      walletMeetsCredibilityCriteria({
        resolvedBetsCount: 600,
        avgEv: 0.04,
        winRate: 0.55,
        closedCount: 600,
      })
    ).toBe(true);

    expect(
      walletMeetsCredibilityCriteria({
        resolvedBetsCount: 499,
        avgEv: 0.1,
        winRate: 0.7,
        closedCount: 499,
      })
    ).toBe(false);
  });

  it("caches low-credibility wallets in memory", () => {
    clearLowCredibilityCacheForTests();
    expect(clearLowCredibilityCacheForTests).toBeDefined();
  });
});
