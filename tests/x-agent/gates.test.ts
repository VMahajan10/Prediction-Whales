import { describe, expect, it } from "vitest";
import type { WhaleRegistry } from "@/lib/crossmarket/store/schema";
import {
  evaluateTradeEligibility,
  type TradePayload,
} from "@/lib/x-agent/gates";

function makeWhale(overrides: Partial<WhaleRegistry> = {}): WhaleRegistry {
  return {
    walletAddress: "0xwhale",
    pseudonym: "DeepWallet",
    resolvedBetsCount: 500,
    avgEv: 0.031,
    winRate: 0.62,
    avgStakeNotional: 20_000,
    postedCount30d: 0,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function makeTrade(overrides: Partial<TradePayload> = {}): TradePayload {
  return {
    source: "polymarket",
    tradeId: `trade-${Math.random().toString(36).slice(2, 10)}`,
    walletAddress: "0xwhale",
    stakeNotional: 25_000,
    timestamp: Math.floor(Date.now() / 1000),
    entryCents: 50,
    nowCents: 52,
    title: "Will China invade Taiwan?",
    outcome: "Yes",
    side: "BUY",
    marketSlug: "china-taiwan-invasion",
    ...overrides,
  };
}

describe("evaluateTradeEligibility", () => {
  it("rejects Kalshi trade payloads with KALSHI_SOURCE_REJECTED", async () => {
    const result = await evaluateTradeEligibility(
      makeTrade({ source: "kalshi" }),
      makeWhale()
    );

    expect(result.eligible).toBe(false);
    expect(result.reason).toBe("KALSHI_SOURCE_REJECTED");
  });

  it("rejects whales with 499 resolved bets", async () => {
    const result = await evaluateTradeEligibility(
      makeTrade(),
      makeWhale({ resolvedBetsCount: 499 })
    );

    expect(result.eligible).toBe(false);
    expect(result.reason).toBe("BELOW_RESOLVED_BETS");
  });

  it("rejects whales with +2.9% average EV", async () => {
    const result = await evaluateTradeEligibility(
      makeTrade(),
      makeWhale({ avgEv: 0.029 })
    );

    expect(result.eligible).toBe(false);
    expect(result.reason).toBe("LOW_EV");
  });

  it("passes the whale EV gate at +3.1% average EV", async () => {
    const result = await evaluateTradeEligibility(
      makeTrade(),
      makeWhale({ avgEv: 0.031 })
    );

    expect(result.reason).not.toBe("LOW_EV");
    expect(result.eligible).toBe(true);
    expect(result.translation).toEqual({
      side: "buy yes",
      marketPlain: "China invade Taiwan",
    });
  });

  it("rejects trades below the $25,000 stake floor", async () => {
    const result = await evaluateTradeEligibility(
      makeTrade({ stakeNotional: 24_999 }),
      makeWhale()
    );

    expect(result.eligible).toBe(false);
    expect(result.reason).toBe("BELOW_STAKE_FLOOR");
  });
});
