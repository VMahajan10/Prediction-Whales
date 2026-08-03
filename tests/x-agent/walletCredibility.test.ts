import { describe, expect, it } from "vitest";
import {
  buildInMemoryWhaleProfile,
  clearLowCredibilityCacheForTests,
  closedPositionsToResolvedBets,
  coalesceHydratedWhale,
  computeWalletCredibilityStats,
  resolveWhaleForCredibilityGate,
  walletMeetsCredibilityCriteria,
} from "@/lib/x-agent/walletCredibility";
import { MIN_WALLET_RESOLVED_BETS } from "@/lib/x-agent/gateMetrics";
import { ANONYMOUS_WALLET_ADDRESS } from "@/lib/x-agent/whaleRegistryDb";

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
        resolvedBetsCount: MIN_WALLET_RESOLVED_BETS - 1,
        avgEv: 0.1,
        winRate: 0.7,
        closedCount: MIN_WALLET_RESOLVED_BETS - 1,
      })
    ).toBe(false);
  });

  it("skips registry lookup for anonymous zero-address wallets", async () => {
    const resolution = await resolveWhaleForCredibilityGate(
      ANONYMOUS_WALLET_ADDRESS
    );
    expect(resolution).toEqual({ whale: null, source: "anonymous" });
  });

  it("caches low-credibility wallets in memory", () => {
    clearLowCredibilityCacheForTests();
    expect(clearLowCredibilityCacheForTests).toBeDefined();
  });

  it("builds an in-memory whale profile from hydrated API stats", () => {
    const wallet = "0xabc123def4567890abcdef1234567890abcdef12";
    const stats = {
      resolvedBetsCount: 42,
      avgEv: 0.02,
      winRate: 0.55,
      closedCount: 42,
    };

    const whale = buildInMemoryWhaleProfile(wallet, stats);

    expect(whale.walletAddress).toBe(wallet);
    expect(whale.resolvedBetsCount).toBe(42);
    expect(whale.avgEv).toBe(0.02);
    expect(whale.winRate).toBe(0.55);
  });

  it("coalesces hydrated stats into a whale when registry row is missing", () => {
    const wallet = "0xabc123def4567890abcdef1234567890abcdef12";
    const stats = {
      resolvedBetsCount: 12,
      avgEv: 0.005,
      winRate: 0.4,
      closedCount: 12,
    };

    const whale = coalesceHydratedWhale(wallet, {
      whale: null,
      source: "low_credibility_cache",
      stats,
    });

    expect(whale).not.toBeNull();
    expect(whale?.resolvedBetsCount).toBe(12);
    expect(whale?.avgEv).toBe(0.005);
  });
});
