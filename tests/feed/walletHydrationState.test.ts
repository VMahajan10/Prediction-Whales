import { describe, expect, it } from "vitest";
import type { WhaleRegistry } from "@/lib/crossmarket/store/schema";
import {
  inferLegacyHydrationStatus,
  isLegacyRegistryShellRow,
  resolveWalletHydrationStatus,
  walletNeedsHistoryHydration,
} from "@/lib/x-agent/walletHydrationState";

const WALLET = "0xabc123def4567890abcdef1234567890abcdef12";
const NOW = new Date("2026-08-24T12:00:00.000Z");

function registryRow(
  overrides: Partial<WhaleRegistry> = {}
): WhaleRegistry {
  return {
    walletAddress: WALLET,
    pseudonym: "Test Whale",
    resolvedBetsCount: 0,
    avgEv: 0,
    winRate: 0,
    avgStakeNotional: 0,
    postedCount30d: 0,
    hydrationStatus: "pending",
    hydratedAt: null,
    lastHydrationAttemptAt: null,
    hydrationError: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe("walletHydrationState", () => {
  it("treats all-default shell rows as pending", () => {
    const row = registryRow();
    expect(isLegacyRegistryShellRow(row)).toBe(true);
    expect(inferLegacyHydrationStatus(row)).toBe("pending");
    expect(walletNeedsHistoryHydration(row)).toBe(true);
  });

  it("treats stake-only enqueue hints as pending", () => {
    const row = registryRow({
      avgEv: 0.35,
      avgStakeNotional: 5000,
    });
    expect(inferLegacyHydrationStatus(row)).toBe("pending");
  });

  it("treats legacy rows with resolved bets as complete via inference", () => {
    const row = registryRow({
      resolvedBetsCount: 12,
      avgEv: 0.04,
      winRate: 0.55,
    });
    expect(inferLegacyHydrationStatus(row)).toBe("complete");
  });

  it("persisted complete status skips hydration", () => {
    const row = registryRow({
      resolvedBetsCount: 12,
      avgEv: 0.04,
      winRate: 0.55,
      hydrationStatus: "complete",
      hydratedAt: NOW,
    });
    expect(resolveWalletHydrationStatus(row)).toBe("complete");
    expect(walletNeedsHistoryHydration(row)).toBe(false);
  });

  it("prefers persisted hydration_status over legacy inference", () => {
    const row = registryRow({
      resolvedBetsCount: 50,
      avgEv: 2.5,
      winRate: 1,
      hydrationStatus: "failed",
      hydrationError: "upstream timeout",
    });
    expect(resolveWalletHydrationStatus(row)).toBe("failed");
    expect(walletNeedsHistoryHydration(row)).toBe(true);
  });
});
