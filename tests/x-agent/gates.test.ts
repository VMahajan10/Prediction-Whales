import { describe, expect, it } from "vitest";
import type { WhaleRegistry } from "@/lib/crossmarket/store/schema";
import {
  evaluateTradeEligibility,
  evaluateTradeGateMatrix,
  MIN_AVG_EV,
  MIN_RESOLVED_BETS,
  MIN_STAKE_NOTIONAL,
  type TradePayload,
} from "@/lib/x-agent/gates";
import { ANONYMOUS_WALLET_ADDRESS } from "@/lib/x-agent/whaleRegistryDb";

function makeWhale(overrides: Partial<WhaleRegistry> = {}): WhaleRegistry {
  return {
    walletAddress: "0xwhale",
    pseudonym: "DeepWallet",
    resolvedBetsCount: MIN_RESOLVED_BETS,
    avgEv: MIN_AVG_EV + 0.001,
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
    stakeNotional: MIN_STAKE_NOTIONAL,
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
      whale: makeWhale({ resolvedBetsCount: MIN_RESOLVED_BETS - 1, avgEv: 0.01 }),
      tradeEvPercent: 5,
    });
    expect(highTradeLowWallet.passesEv).toBe(true);
    expect(highTradeLowWallet.passesCredibility).toBe(false);
    expect(highTradeLowWallet.tradeEvDecimal).toBe(0.05);
    expect(highTradeLowWallet.walletAvgEv).toBe(0.01);

    const lowTradeHighWallet = evaluateTradeGateMatrix({
      trade: makeTrade(),
      whale: makeWhale({ resolvedBetsCount: 600, avgEv: 0.04 }),
      tradeEvPercent: 1.0,
    });
    expect(lowTradeHighWallet.passesEv).toBe(false);
    expect(lowTradeHighWallet.passesCredibility).toBe(true);
    expect(lowTradeHighWallet.tradeEvDecimal).toBe(0.01);
    expect(lowTradeHighWallet.walletAvgEv).toBe(0.04);
  });

  it("records independent failures across multiple gates", () => {
    const matrix = evaluateTradeGateMatrix({
      trade: makeTrade({
        source: "kalshi",
        stakeNotional: MIN_STAKE_NOTIONAL - 1,
      }),
      whale: makeWhale({ resolvedBetsCount: MIN_RESOLVED_BETS - 1, avgEv: 0.01 }),
      tradeEvPercent: 1.0,
    });

    expect(matrix.passesSource).toBe(false);
    expect(matrix.passesEv).toBe(false);
    expect(matrix.passesStake).toBe(false);
    expect(matrix.passesCredibility).toBe(false);
    expect(matrix.passesAll).toBe(false);
  });

  it("passes credibility for anonymous zero-address trades without whale lookup", () => {
    const matrix = evaluateTradeGateMatrix({
      trade: makeTrade({ walletAddress: ANONYMOUS_WALLET_ADDRESS }),
      whale: null,
      tradeEvPercent: 2.0,
    });

    expect(matrix.passesCredibility).toBe(true);
    expect(matrix.passesAll).toBe(true);
  });

  it("passes all gates when every condition is met", () => {
    const matrix = evaluateTradeGateMatrix({
      trade: makeTrade(),
      whale: makeWhale(),
      tradeEvPercent: 2.0,
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

  it("rejects whales below the resolved-bets floor", async () => {
    const result = await evaluateTradeEligibility(
      makeTrade(),
      makeWhale({ resolvedBetsCount: MIN_RESOLVED_BETS - 1 }),
      Date.now(),
      { tradeEvPercent: 5 }
    );

    expect(result.eligible).toBe(false);
    expect(result.matrix.passesCredibility).toBe(false);
  });

  it("rejects whales below the wallet avg EV floor", async () => {
    const result = await evaluateTradeEligibility(
      makeTrade(),
      makeWhale({ avgEv: MIN_AVG_EV - 0.001 }),
      Date.now(),
      { tradeEvPercent: 5 }
    );

    expect(result.eligible).toBe(false);
    expect(result.matrix.passesCredibility).toBe(false);
  });

  it("passes the whale EV gate at the avg EV floor", async () => {
    const result = await evaluateTradeEligibility(
      makeTrade(),
      makeWhale({ avgEv: MIN_AVG_EV + 0.001 }),
      Date.now(),
      { tradeEvPercent: 5 }
    );

    expect(result.eligible).toBe(true);
    expect(result.translation).toEqual({
      side: "buy yes",
      marketPlain: "China invade Taiwan",
    });
  });

  it("passes credibility for anonymous trades via evaluateTradeEligibility", async () => {
    const result = await evaluateTradeEligibility(
      makeTrade({ walletAddress: ANONYMOUS_WALLET_ADDRESS }),
      null,
      Date.now(),
      { tradeEvPercent: 2.0 }
    );

    expect(result.matrix.passesCredibility).toBe(true);
    expect(result.eligible).toBe(true);
  });

  it("rejects trades below the stake floor", async () => {
    const result = await evaluateTradeEligibility(
      makeTrade({ stakeNotional: MIN_STAKE_NOTIONAL - 1 }),
      makeWhale(),
      Date.now(),
      { tradeEvPercent: 5 }
    );

    expect(result.eligible).toBe(false);
    expect(result.matrix.passesStake).toBe(false);
  });
});
