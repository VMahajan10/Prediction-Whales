import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  passesPolymarketFeedTraderGate,
  passesPolymarketTraderCredibilityForFeed,
} from "@/lib/feedQualification";
import { qualifyWalletForFeed } from "@/lib/feedQualificationServer";
import {
  resolvePolymarketWalletQualificationState,
} from "@/lib/whaleFeedClientQualification";
import type { WalletQualification } from "@/lib/useQualifiedWalletFilter";

const WALLET = "0xabc123def4567890abcdef1234567890abcdef12";

vi.mock("@/lib/x-agent/whaleRegistryDb", () => ({
  findWhaleByWalletCaseInsensitive: vi.fn(),
}));

vi.mock("@/lib/whaleIdentityResolver", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/whaleIdentityResolver")>();
  return {
    ...actual,
    resolveWhaleIdentity: vi.fn(() => ({
      pseudonym: "Test Whale",
      initials: "TW",
      winRate: null,
      resolvedBetsCount: null,
      avgEv: null,
      roi: null,
    })),
  };
});

import { findWhaleByWalletCaseInsensitive } from "@/lib/x-agent/whaleRegistryDb";

const mockedFindWhale = vi.mocked(findWhaleByWalletCaseInsensitive);

function completeQualification(
  overrides: Partial<WalletQualification> = {}
): WalletQualification {
  return {
    qualified: true,
    hydrationState: "complete",
    avgEv: 0.05,
    resolvedBetsCount: 20,
    avgStakeNotional: 50,
    resolvedVolumeUSD: 1000,
    identity: {
      pseudonym: "Qualified",
      initials: "Q",
      winRate: 0.6,
      resolvedBetsCount: 20,
      avgEv: 0.05,
      roi: null,
    },
    ...overrides,
  };
}

describe("wallet hydration qualification", () => {
  beforeEach(() => {
    mockedFindWhale.mockReset();
  });

  it("pending wallet fails closed and is not a credibility evaluation", async () => {
    mockedFindWhale.mockResolvedValue({
      walletAddress: WALLET,
      pseudonym: "Shell",
      resolvedBetsCount: 0,
      avgEv: 0,
      winRate: 0,
      avgStakeNotional: 0,
      postedCount30d: 0,
      hydrationStatus: "pending",
      hydratedAt: null,
      lastHydrationAttemptAt: null,
      hydrationError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await qualifyWalletForFeed(WALLET);
    expect(result.qualified).toBe(false);
    expect(result.hydrationState).toBe("pending");
    expect(result.avgEv).toBeNull();
    expect(passesPolymarketFeedTraderGate(WALLET, result)).toBe(false);
  });

  it("failed hydration fails closed without treating zeros as credible", async () => {
    mockedFindWhale.mockResolvedValue({
      walletAddress: WALLET,
      pseudonym: "Failed",
      resolvedBetsCount: 0,
      avgEv: 0,
      winRate: 0,
      avgStakeNotional: 0,
      postedCount30d: 0,
      hydrationStatus: "failed",
      hydratedAt: null,
      lastHydrationAttemptAt: new Date(),
      hydrationError: "network error",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await qualifyWalletForFeed(WALLET);
    expect(result.qualified).toBe(false);
    expect(result.hydrationState).toBe("failed");
    expect(passesPolymarketFeedTraderGate(WALLET, result)).toBe(false);
  });

  it("complete + passing wallet qualifies", async () => {
    mockedFindWhale.mockResolvedValue({
      walletAddress: WALLET,
      pseudonym: "Qualified",
      resolvedBetsCount: 20,
      avgEv: 0.05,
      winRate: 0.6,
      avgStakeNotional: 50,
      postedCount30d: 0,
      hydrationStatus: "complete",
      hydratedAt: new Date(),
      lastHydrationAttemptAt: new Date(),
      hydrationError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await qualifyWalletForFeed(WALLET);
    expect(result.hydrationState).toBe("complete");
    expect(result.qualified).toBe(true);
    expect(passesPolymarketFeedTraderGate(WALLET, result)).toBe(true);
  });

  it("complete + failing wallet is a credibility failure, not hydration failure", async () => {
    mockedFindWhale.mockResolvedValue({
      walletAddress: WALLET,
      pseudonym: "Low EV",
      resolvedBetsCount: 3,
      avgEv: 0.01,
      winRate: 0.4,
      avgStakeNotional: 0,
      postedCount30d: 0,
      hydrationStatus: "complete",
      hydratedAt: new Date(),
      lastHydrationAttemptAt: new Date(),
      hydrationError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await qualifyWalletForFeed(WALLET);
    expect(result.hydrationState).toBe("complete");
    expect(result.qualified).toBe(false);
    expect(result.resolvedBetsCount).toBe(3);
    expect(passesPolymarketFeedTraderGate(WALLET, result)).toBe(false);
  });

  it("legacy shell row without hydration_status stays pending", async () => {
    mockedFindWhale.mockResolvedValue({
      walletAddress: WALLET,
      pseudonym: "Legacy Shell",
      resolvedBetsCount: 0,
      avgEv: 0,
      winRate: 0,
      avgStakeNotional: 0,
      postedCount30d: 0,
      hydrationStatus: "pending",
      hydratedAt: null,
      lastHydrationAttemptAt: null,
      hydrationError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await qualifyWalletForFeed(WALLET);
    expect(result.hydrationState).toBe("pending");
    expect(result.qualified).toBe(false);
  });

  it("client maps hydration states to pending/fail without admitting pending wallets", () => {
    const quals = new Map<string, WalletQualification>([
      [WALLET, completeQualification({ hydrationState: "pending", qualified: false })],
    ]);
    expect(
      resolvePolymarketWalletQualificationState(WALLET, quals)
    ).toBe("pending");

    quals.set(
      WALLET,
      completeQualification({ hydrationState: "failed", qualified: false })
    );
    expect(
      resolvePolymarketWalletQualificationState(WALLET, quals)
    ).toBe("fail");
  });

  it("does not restore isTraderMetricsUncalculated as an admission bypass", () => {
    expect(
      passesPolymarketTraderCredibilityForFeed({
        hydrationState: "pending",
        resolvedBetsCount: 0,
        avgEv: 0,
        avgStakeNotional: 0,
        resolvedVolumeUSD: 0,
      })
    ).toBe(false);
  });
});
