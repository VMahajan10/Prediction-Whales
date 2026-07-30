import { describe, expect, it } from "vitest";
import type { WhaleRegistry } from "@/lib/crossmarket/store/schema";
import {
  evaluateDeterministicPreGates,
  evaluateTradeEligibility,
  evaluateTradeEvPreGate,
  evaluateTradeGateMatrix,
  evaluateWalletCredibilityPreGate,
  MAX_TRADE_AGE_MS,
  MIN_AVG_EV,
  MIN_RESOLVED_BETS,
  type TradePayload,
} from "@/lib/x-agent/gates";
import {
  STAKE_FLOOR_DEFAULT_USD,
  STAKE_FLOOR_MACRO_POLITICAL_USD,
  STAKE_FLOOR_SPORTS_ENTERTAINMENT_USD,
} from "@/lib/x-agent/stakeFloor";
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
    stakeNotional: STAKE_FLOOR_DEFAULT_USD,
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

describe("evaluateDeterministicPreGates", () => {
  it("short-circuits on freshness before stake or alignment", () => {
    const staleMs = MAX_TRADE_AGE_MS + 60_000;
    const result = evaluateDeterministicPreGates(
      makeTrade({
        stakeNotional: STAKE_FLOOR_DEFAULT_USD - 1,
        timestamp: Math.floor((Date.now() - staleMs) / 1000),
      }),
      Date.now()
    );

    expect(result.passed).toBe(false);
    expect(result.failedStep).toBe("freshness");
    expect(result.reason).toBe("STALE_TRADE");
  });

  it("short-circuits on stake after freshness passes", () => {
    const result = evaluateDeterministicPreGates(
      makeTrade({ stakeNotional: STAKE_FLOOR_DEFAULT_USD - 1 }),
      Date.now()
    );

    expect(result.passed).toBe(false);
    expect(result.failedStep).toBe("stake");
    expect(result.reason).toBe("BELOW_STAKE_FLOOR");
  });

  it("applies the sports tier stake floor", () => {
    const belowSportsFloor = evaluateDeterministicPreGates(
      makeTrade({
        title: "Lakers vs Celtics NBA",
        stakeNotional: STAKE_FLOOR_SPORTS_ENTERTAINMENT_USD - 1,
      }),
      Date.now()
    );
    expect(belowSportsFloor.passed).toBe(false);
    expect(belowSportsFloor.failedStep).toBe("stake");

    const aboveSportsFloor = evaluateDeterministicPreGates(
      makeTrade({
        title: "Lakers vs Celtics NBA",
        stakeNotional: STAKE_FLOOR_SPORTS_ENTERTAINMENT_USD,
      }),
      Date.now()
    );
    expect(aboveSportsFloor.passed).toBe(true);
  });

  it("returns translation when freshness, stake, and alignment pass", () => {
    const result = evaluateDeterministicPreGates(makeTrade(), Date.now());

    expect(result.passed).toBe(true);
    expect(result.translation).toEqual({
      side: "bought yes",
      marketPlain: "China invade Taiwan",
    });
  });
});

describe("evaluateWalletCredibilityPreGate", () => {
  it("fails when whale is missing from registry", () => {
    const result = evaluateWalletCredibilityPreGate(makeTrade(), null);

    expect(result.passed).toBe(false);
    expect(result.failedStep).toBe("credibility");
  });
});

describe("evaluateTradeEvPreGate", () => {
  it("fails when live trade EV is below the floor", () => {
    const result = evaluateTradeEvPreGate(2.0);

    expect(result.passed).toBe(false);
    expect(result.reason).toBe("BELOW_TRADE_EV");
  });

  it("passes when live trade EV meets the floor", () => {
    const result = evaluateTradeEvPreGate(2.5);

    expect(result.passed).toBe(true);
  });
});

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
      tradeEvPercent: 2.0,
    });
    expect(lowTradeHighWallet.passesEv).toBe(false);
    expect(lowTradeHighWallet.passesCredibility).toBe(true);
    expect(lowTradeHighWallet.tradeEvDecimal).toBe(0.02);
    expect(lowTradeHighWallet.walletAvgEv).toBe(0.04);
  });

  it("records independent failures across multiple gates", () => {
    const matrix = evaluateTradeGateMatrix({
      trade: makeTrade({
        source: "kalshi",
        stakeNotional: STAKE_FLOOR_DEFAULT_USD - 1,
      }),
      whale: makeWhale({ resolvedBetsCount: MIN_RESOLVED_BETS - 1, avgEv: 0.01 }),
      tradeEvPercent: 2.0,
    });

    expect(matrix.passesSource).toBe(false);
    expect(matrix.passesEv).toBe(false);
    expect(matrix.passesStake).toBe(false);
    expect(matrix.passesCredibility).toBe(false);
    expect(matrix.passesAll).toBe(false);
  });

  it("fails credibility for anonymous zero-address trades without whale lookup", () => {
    const matrix = evaluateTradeGateMatrix({
      trade: makeTrade({ walletAddress: ANONYMOUS_WALLET_ADDRESS }),
      whale: null,
      tradeEvPercent: 3.0,
    });

    expect(matrix.passesCredibility).toBe(false);
    expect(matrix.passesAll).toBe(false);
    expect(matrix.primaryFailureReason).toBe("BELOW_RESOLVED_BETS");
  });

  it("applies the macro/political stake tier", () => {
    const matrix = evaluateTradeGateMatrix({
      trade: makeTrade({
        title: "Will Trump win the election?",
        stakeNotional: STAKE_FLOOR_MACRO_POLITICAL_USD - 1,
      }),
      whale: makeWhale(),
      tradeEvPercent: 3.0,
    });

    expect(matrix.stakeFloorTier).toBe("macro_political");
    expect(matrix.passesStake).toBe(false);
  });

  it("passes all gates when every condition is met", () => {
    const matrix = evaluateTradeGateMatrix({
      trade: makeTrade(),
      whale: makeWhale(),
      tradeEvPercent: 3.0,
    });

    expect(matrix.passesAll).toBe(true);
    expect(matrix.translation).toEqual({
      side: "bought yes",
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
      side: "bought yes",
      marketPlain: "China invade Taiwan",
    });
  });

  it("rejects anonymous trades with zero resolved history", async () => {
    const result = await evaluateTradeEligibility(
      makeTrade({ walletAddress: ANONYMOUS_WALLET_ADDRESS }),
      null,
      Date.now(),
      { tradeEvPercent: 3.0 }
    );

    expect(result.matrix.passesCredibility).toBe(false);
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe("BELOW_RESOLVED_BETS");
  });

  it("rejects wallets with zero resolved bets", async () => {
    const result = await evaluateTradeEligibility(
      makeTrade(),
      makeWhale({ resolvedBetsCount: 0 }),
      Date.now(),
      { tradeEvPercent: 5 }
    );

    expect(result.eligible).toBe(false);
    expect(result.matrix.passesCredibility).toBe(false);
    expect(result.reason).toBe("BELOW_RESOLVED_BETS");
  });

  it("rejects trades below the stake floor", async () => {
    const result = await evaluateTradeEligibility(
      makeTrade({ stakeNotional: STAKE_FLOOR_DEFAULT_USD - 1 }),
      makeWhale(),
      Date.now(),
      { tradeEvPercent: 5 }
    );

    expect(result.eligible).toBe(false);
    expect(result.matrix.passesStake).toBe(false);
  });
});
