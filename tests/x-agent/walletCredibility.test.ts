import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  buildInMemoryWhaleProfile,
  clearLowCredibilityCacheForTests,
  closedPositionsToResolvedBets,
  computeWalletCredibilityStats,
  resolveWhaleForCredibilityGate,
  walletMeetsCredibilityCriteria,
} from "@/lib/x-agent/walletCredibility";
import { MIN_WALLET_RESOLVED_BETS } from "@/lib/x-agent/gateMetrics";
import { ANONYMOUS_WALLET_ADDRESS } from "@/lib/x-agent/whaleRegistryDb";

const { mockFetchClosedPositions, mockUpsertWhaleRegistry, mockFindWhale } =
  vi.hoisted(() => ({
    mockFetchClosedPositions: vi.fn(),
    mockUpsertWhaleRegistry: vi.fn(),
    mockFindWhale: vi.fn(),
  }));

vi.mock("@/lib/polymarket", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/polymarket")>();
  return {
    ...actual,
    fetchClosedPositions: (...args: unknown[]) =>
      mockFetchClosedPositions(...args),
  };
});

vi.mock("@/lib/x-agent/whaleRegistryDb", () => ({
  ANONYMOUS_WALLET_ADDRESS:
    "0x0000000000000000000000000000000000000000",
  isAnonymousWalletAddress: (wallet: string | null | undefined) => {
    if (wallet == null) return true;
    const normalized = wallet.trim().toLowerCase();
    return (
      !normalized ||
      normalized === "0x0000000000000000000000000000000000000000"
    );
  },
  normalizeWalletAddress: (wallet: string) => wallet.trim().toLowerCase(),
  formatWalletPseudonym: (wallet: string) => wallet,
  findWhaleByWalletCaseInsensitive: (...args: unknown[]) =>
    mockFindWhale(...args),
  upsertWhaleRegistry: (...args: unknown[]) =>
    mockUpsertWhaleRegistry(...args),
}));

const WALLET = "0xabc123def4567890abcdef1234567890abcdef12";

describe("walletCredibility", () => {
  beforeEach(() => {
    mockFetchClosedPositions.mockReset();
    mockUpsertWhaleRegistry.mockReset();
    mockFindWhale.mockReset();
    clearLowCredibilityCacheForTests();
    process.env.X_AGENT_WALLET_HYDRATION_FALLBACK = "false";
    process.env.NODE_ENV = "production";
  });

  afterEach(() => {
    delete process.env.X_AGENT_WALLET_HYDRATION_FALLBACK;
  });
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
        resolvedBetsCount: 600,
        avgEv: 0.03,
        winRate: 0.55,
        closedCount: 600,
      })
    ).toBe(true);

    expect(
      walletMeetsCredibilityCriteria({
        resolvedBetsCount: 600,
        avgEv: 0.0299,
        winRate: 0.55,
        closedCount: 600,
      })
    ).toBe(false);

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

  it("persists failed hydration without fabricating resolved bet metrics", async () => {
    mockFindWhale.mockResolvedValue(null);
    mockFetchClosedPositions.mockRejectedValue(new Error("upstream timeout"));
    mockUpsertWhaleRegistry.mockResolvedValue({
      walletAddress: WALLET,
      hydrationStatus: "failed",
      hydrationError: "upstream timeout",
      resolvedBetsCount: 0,
      avgEv: 0,
      winRate: 0,
    });

    const resolution = await resolveWhaleForCredibilityGate(WALLET);

    expect(resolution.hydrationStatus).toBe("failed");
    expect(resolution.whale?.resolvedBetsCount ?? 0).toBe(0);
    expect(mockUpsertWhaleRegistry).toHaveBeenCalledWith(
      expect.objectContaining({
        walletAddress: WALLET,
        hydrationStatus: "failed",
        hydrationError: "upstream timeout",
      })
    );
  });

  it("persists complete hydration even when credibility thresholds fail", async () => {
    mockFindWhale.mockResolvedValue(null);
    mockFetchClosedPositions.mockResolvedValue([
      { avgPrice: 0.4, realizedPnl: 5 },
    ]);
    mockUpsertWhaleRegistry.mockImplementation(async (input) => ({
      walletAddress: WALLET,
      pseudonym: "Test",
      resolvedBetsCount: input.resolvedBetsCount ?? 0,
      avgEv: input.avgEv ?? 0,
      winRate: input.winRate ?? 0,
      avgStakeNotional: 0,
      postedCount30d: 0,
      hydrationStatus: input.hydrationStatus ?? "pending",
      hydratedAt: input.hydratedAt ?? null,
      lastHydrationAttemptAt: input.lastHydrationAttemptAt ?? null,
      hydrationError: input.hydrationError ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));

    const resolution = await resolveWhaleForCredibilityGate(WALLET);

    expect(resolution.hydrationStatus).toBe("complete");
    expect(resolution.stats?.resolvedBetsCount).toBe(1);
    expect(walletMeetsCredibilityCriteria(resolution.stats!)).toBe(false);
    expect(mockUpsertWhaleRegistry).toHaveBeenCalledWith(
      expect.objectContaining({
        hydrationStatus: "complete",
        resolvedBetsCount: 1,
      })
    );
  });
});
