import { describe, expect, it } from "vitest";
import type { WhaleRegistry } from "@/lib/crossmarket/store/schema";
import {
  evaluateTradeEligibility,
  evaluateTradeGateMatrix,
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

describe("evaluateTradeGateMatrix", () => {
  it("evaluates trade EV and wallet credibility independently", () => {
    const highTradeLowWallet = evaluateTradeGateMatrix({
      trade: makeTrade(),
      whale: makeWhale({ resolvedBetsCount: 100, avgEv: 0.01 }),
      tradeEvPercent: 5,
    });
    expect(highTradeLowWallet.passesEv).toBe(true);
    expect(highTradeLowWallet.passesCredibility).toBe(false);
    expect(highTradeLowWallet.tradeEvDecimal).toBe(0.05);
    expect(highTradeLowWallet.walletAvgEv).toBe(0.01);

    const lowTradeHighWallet = evaluateTradeGateMatrix({
      trade: makeTrade(),
      whale: makeWhale({ resolvedBetsCount: 600, avgEv: 0.04 }),
      tradeEvPercent: 1.5,
    });
    expect(lowTradeHighWallet.passesEv).toBe(false);
    expect(lowTradeHighWallet.passesCredibility).toBe(true);
    expect(lowTradeHighWallet.tradeEvDecimal).toBe(0.015);
    expect(lowTradeHighWallet.walletAvgEv).toBe(0.04);
  });

  it("records independent failures across multiple gates", () => {
    const matrix = evaluateTradeGateMatrix({
      trade: makeTrade({
        source: "kalshi",
        stakeNotional: 10_000,
      }),
      whale: makeWhale({ resolvedBetsCount: 100, avgEv: 0.01 }),
      tradeEvPercent: 1.5,
    });

    expect(matrix.passesSource).toBe(false);
    expect(matrix.passesEv).toBe(false);
    expect(matrix.passesStake).toBe(false);
    expect(matrix.passesCredibility).toBe(false);
    expect(matrix.passesAll).toBe(false);
  });

  it("passes all gates when every condition is met", () => {
    const matrix = evaluateTradeGateMatrix({
      trade: makeTrade(),
      whale: makeWhale(),
      tradeEvPercent: 3.5,
    });

    expect(matrix.passesAll).toBe(true);
    expect(matrix.translation).toEqual({
      side: "buy yes",
      marketPlain: "China invade Taiwan",
    });
  });
});

describe("evaluateTradeEligibility", () => {
  it("rejects Kalshi trade payloads with KALSHI_SOURCE_REJECTED", async () => {
    const result = await evaluateTradeEligibility(
      makeTrade({ source: "kalshi" }),
      makeWhale(),
      Date.now(),
      { tradeEvPercent: 5 }
    );

    expect(result.eligible).toBe(false);
    expect(result.reason).toBe("KALSHI_SOURCE_REJECTED");
    expect(result.matrix.passesSource).toBe(false);
  });

  it("rejects whales with 499 resolved bets", async () => {
    const result = await evaluateTradeEligibility(
      makeTrade(),
      makeWhale({ resolvedBetsCount: 499 }),
      Date.now(),
      { tradeEvPercent: 5 }
    );

    expect(result.eligible).toBe(false);
    expect(result.matrix.passesCredibility).toBe(false);
  });

  it("rejects whales with +2.9% average EV", async () => {
    const result = await evaluateTradeEligibility(
      makeTrade(),
      makeWhale({ avgEv: 0.029 }),
      Date.now(),
      { tradeEvPercent: 5 }
    );

    expect(result.eligible).toBe(false);
    expect(result.matrix.passesCredibility).toBe(false);
  });

  it("passes the whale EV gate at +3.1% average EV", async () => {
    const result = await evaluateTradeEligibility(
      makeTrade(),
      makeWhale({ avgEv: 0.031 }),
      Date.now(),
      { tradeEvPercent: 5 }
    );

    expect(result.eligible).toBe(true);
    expect(result.translation).toEqual({
      side: "buy yes",
      marketPlain: "China invade Taiwan",
    });
  });

  it("rejects trades below the $25,000 stake floor", async () => {
    const result = await evaluateTradeEligibility(
      makeTrade({ stakeNotional: 24_999 }),
      makeWhale(),
      Date.now(),
      { tradeEvPercent: 5 }
    );

    expect(result.eligible).toBe(false);
    expect(result.matrix.passesStake).toBe(false);
  });
});
