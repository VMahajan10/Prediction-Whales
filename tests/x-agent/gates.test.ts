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
  FAILED_TRADE_EV_REASON,
} from "@/lib/x-agent/gateMetrics";
import {
  SHADOW_UNREGISTERED_STAKE_BYPASS_USD,
} from "@/lib/x-agent/postQueueGates";
import {
  STAKE_FLOOR_DEFAULT_USD,
  STAKE_FLOOR_MACRO_POLITICAL_USD,
  STAKE_FLOOR_SPORTS_ENTERTAINMENT_USD,
} from "@/lib/x-agent/stakeFloor";
import { ANONYMOUS_WALLET_ADDRESS } from "@/lib/x-agent/whaleRegistryDb";

function withStrictCredibilityGates<T>(fn: () => T): T {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousShadow = process.env.ALLOW_UNREGISTERED_WALLETS_IN_SHADOW;
  const previousUnindexed = process.env.ALLOW_UNINDEXED_WALLETS;
  const previousHydrationFallback = process.env.X_AGENT_WALLET_HYDRATION_FALLBACK;
  process.env.NODE_ENV = "production";
  process.env.ALLOW_UNREGISTERED_WALLETS_IN_SHADOW = "false";
  process.env.ALLOW_UNINDEXED_WALLETS = "false";
  process.env.X_AGENT_WALLET_HYDRATION_FALLBACK = "false";

  try {
    return fn();
  } finally {
    process.env.NODE_ENV = previousNodeEnv;
    if (previousShadow === undefined) {
      delete process.env.ALLOW_UNREGISTERED_WALLETS_IN_SHADOW;
    } else {
      process.env.ALLOW_UNREGISTERED_WALLETS_IN_SHADOW = previousShadow;
    }
    if (previousUnindexed === undefined) {
      delete process.env.ALLOW_UNINDEXED_WALLETS;
    } else {
      process.env.ALLOW_UNINDEXED_WALLETS = previousUnindexed;
    }
    if (previousHydrationFallback === undefined) {
      delete process.env.X_AGENT_WALLET_HYDRATION_FALLBACK;
    } else {
      process.env.X_AGENT_WALLET_HYDRATION_FALLBACK = previousHydrationFallback;
    }
  }
}

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

  it("uses a flat $500 post-queue stake floor for all categories", () => {
    const belowFlatFloor = evaluateDeterministicPreGates(
      makeTrade({
        title: "Lakers vs Celtics NBA",
        stakeNotional: STAKE_FLOOR_DEFAULT_USD - 1,
      }),
      Date.now()
    );
    expect(belowFlatFloor.passed).toBe(false);
    expect(belowFlatFloor.failedStep).toBe("stake");

    const aboveFlatFloor = evaluateDeterministicPreGates(
      makeTrade({
        title: "Lakers vs Celtics NBA",
        stakeNotional: STAKE_FLOOR_DEFAULT_USD,
      }),
      Date.now()
    );
    expect(aboveFlatFloor.passed).toBe(true);

    const macroBelowFlatFloor = evaluateDeterministicPreGates(
      makeTrade({
        title: "Will Trump win the election?",
        stakeNotional: STAKE_FLOOR_MACRO_POLITICAL_USD - 1,
      }),
      Date.now()
    );
    expect(macroBelowFlatFloor.passed).toBe(true);
  });

  it("returns translation when freshness, stake, and alignment pass", () => {
    const result = evaluateDeterministicPreGates(makeTrade(), Date.now());

    expect(result.passed).toBe(true);
    expect(result.translation).toEqual({
      side: "China invade Taiwan",
      marketPlain: "China invade Taiwan",
    });
  });
});

describe("evaluateWalletCredibilityPreGate", () => {
  it("passes when whale is missing from registry while metrics are uncalculated", () => {
    const result = withStrictCredibilityGates(() =>
      evaluateWalletCredibilityPreGate(
        makeTrade({
          title: "Lakers vs Celtics NBA",
          stakeNotional: STAKE_FLOOR_DEFAULT_USD,
        }),
        null
      )
    );

    expect(result.passed).toBe(true);
  });
});

describe("evaluateTradeEvPreGate", () => {
  it("fails when live trade EV is below +3.0%", () => {
    expect(evaluateTradeEvPreGate(-0.1).passed).toBe(false);
    expect(evaluateTradeEvPreGate(-0.1).reason).toBe(FAILED_TRADE_EV_REASON);
    expect(evaluateTradeEvPreGate(0).passed).toBe(false);
    expect(evaluateTradeEvPreGate(2.9).passed).toBe(false);
  });

  it("passes at or above +3.0% floor", () => {
    expect(evaluateTradeEvPreGate(3.0).passed).toBe(true);
    expect(evaluateTradeEvPreGate(3.5).passed).toBe(true);
    expect(evaluateTradeEvPreGate(5.0).passed).toBe(true);
  });

  it("fails whale-tier negative or neutral EV without bypass", () => {
    expect(evaluateTradeEvPreGate(0).passed).toBe(false);
    expect(evaluateTradeEvPreGate(-0.5).passed).toBe(false);
    expect(evaluateTradeEvPreGate(null).passed).toBe(false);
  });
});

describe("evaluateTradeGateMatrix", () => {
  it("evaluates trade EV and wallet credibility independently", () => {
    const highTradeLowWallet = withStrictCredibilityGates(() =>
      evaluateTradeGateMatrix({
        trade: makeTrade(),
        whale: makeWhale({
          resolvedBetsCount: MIN_RESOLVED_BETS - 1,
          avgEv: 0.01,
        }),
        tradeEvPercent: 5,
      })
    );
    expect(highTradeLowWallet.passesEv).toBe(true);
    expect(highTradeLowWallet.passesCredibility).toBe(false);
    expect(highTradeLowWallet.tradeEvDecimal).toBe(0.05);
    expect(highTradeLowWallet.walletAvgEv).toBe(0.01);

    const lowTradeHighWallet = evaluateTradeGateMatrix({
      trade: makeTrade(),
      whale: makeWhale({ resolvedBetsCount: 600, avgEv: 0.04 }),
      tradeEvPercent: 5.0,
    });
    expect(lowTradeHighWallet.passesEv).toBe(true);
    expect(lowTradeHighWallet.passesCredibility).toBe(true);
    expect(lowTradeHighWallet.tradeEvDecimal).toBe(0.05);
    expect(lowTradeHighWallet.walletAvgEv).toBe(0.04);

    const belowTradeEvFloor = evaluateTradeGateMatrix({
      trade: makeTrade(),
      whale: makeWhale({ resolvedBetsCount: 600, avgEv: 0.04 }),
      tradeEvPercent: -1.0,
    });
    expect(belowTradeEvFloor.passesEv).toBe(false);
    expect(belowTradeEvFloor.passesCredibility).toBe(true);
    expect(belowTradeEvFloor.tradeEvDecimal).toBe(-0.01);
  });

  it("records independent failures across multiple gates", () => {
    const matrix = withStrictCredibilityGates(() =>
      evaluateTradeGateMatrix({
        trade: makeTrade({
          source: "kalshi",
          stakeNotional: STAKE_FLOOR_DEFAULT_USD - 1,
        }),
        whale: makeWhale({
          resolvedBetsCount: MIN_RESOLVED_BETS - 1,
          avgEv: 0.01,
        }),
        tradeEvPercent: -1.0,
      })
    );

    expect(matrix.passesSource).toBe(false);
    expect(matrix.passesEv).toBe(false);
    expect(matrix.passesStake).toBe(false);
    expect(matrix.passesCredibility).toBe(false);
    expect(matrix.passesAll).toBe(false);
  });

  it("bypasses credibility for anonymous zero-address trades", () => {
    const matrix = withStrictCredibilityGates(() =>
      evaluateTradeGateMatrix({
        trade: makeTrade({
          title: "Lakers vs Celtics NBA",
          walletAddress: ANONYMOUS_WALLET_ADDRESS,
          stakeNotional: STAKE_FLOOR_DEFAULT_USD,
        }),
        whale: null,
        tradeEvPercent: 3.0,
      })
    );

    expect(matrix.passesCredibility).toBe(true);
    expect(matrix.passesStake).toBe(true);
    expect(matrix.passesAll).toBe(true);
  });

  it("passes anonymous high-stake trades without resolved bets", () => {
    const result = withStrictCredibilityGates(() =>
      evaluateWalletCredibilityPreGate(
        makeTrade({
          walletAddress: ANONYMOUS_WALLET_ADDRESS,
          stakeNotional: SHADOW_UNREGISTERED_STAKE_BYPASS_USD,
        }),
        null
      )
    );

    expect(result.passed).toBe(true);
  });

  it("uses the flat post-queue stake floor in the gate matrix", () => {
    const matrix = evaluateTradeGateMatrix({
      trade: makeTrade({
        title: "Will Trump win the election?",
        stakeNotional: STAKE_FLOOR_DEFAULT_USD - 1,
      }),
      whale: makeWhale(),
      tradeEvPercent: 3.0,
    });

    expect(matrix.stakeFloorTier).toBe("default");
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
      side: "China invade Taiwan",
      marketPlain: "China invade Taiwan",
    });
  });
});

describe("evaluateTradeEligibility", () => {
  it("rejects Kalshi trade payloads with KALSHI_PUBLIC_POSTING_DISABLED", async () => {
    const result = await evaluateTradeEligibility(
      makeTrade({ source: "kalshi" }),
      makeWhale(),
      Date.now(),
      { tradeEvPercent: 5 }
    );

    expect(result.eligible).toBe(false);
    expect(result.reason).toBe("KALSHI_PUBLIC_POSTING_DISABLED");
    expect(result.matrix.passesSource).toBe(false);
  });

  it("rejects whales below the resolved-bets floor", async () => {
    const result = await withStrictCredibilityGates(() =>
      evaluateTradeEligibility(
        makeTrade(),
        makeWhale({ resolvedBetsCount: MIN_RESOLVED_BETS - 1 }),
        Date.now(),
        { tradeEvPercent: 5 }
      )
    );

    expect(result.eligible).toBe(false);
    expect(result.matrix.passesCredibility).toBe(false);
  });

  it("rejects whales below the wallet avg EV floor", async () => {
    const result = await withStrictCredibilityGates(() =>
      evaluateTradeEligibility(
        makeTrade(),
        makeWhale({ avgEv: MIN_AVG_EV - 0.001 }),
        Date.now(),
        { tradeEvPercent: 5 }
      )
    );

    expect(result.eligible).toBe(false);
    expect(result.matrix.passesCredibility).toBe(false);
    expect(result.reason).toBe("BELOW_EV_THRESHOLD");
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
      side: "China invade Taiwan",
      marketPlain: "China invade Taiwan",
    });
  });

  it("passes anonymous trades without resolved history", async () => {
    const result = await withStrictCredibilityGates(() =>
      evaluateTradeEligibility(
        makeTrade({
          title: "Lakers vs Celtics NBA",
          walletAddress: ANONYMOUS_WALLET_ADDRESS,
          stakeNotional: STAKE_FLOOR_DEFAULT_USD,
        }),
        null,
        Date.now(),
        { tradeEvPercent: 3.0 }
      )
    );

    expect(result.matrix.passesCredibility).toBe(true);
    expect(result.matrix.passesStake).toBe(true);
    expect(result.eligible).toBe(true);
  });

  it("rejects wallets below the resolved-bets floor without hydration bypass", async () => {
    const result = await withStrictCredibilityGates(() =>
      evaluateTradeEligibility(
        makeTrade({
          title: "Lakers vs Celtics NBA",
          stakeNotional: STAKE_FLOOR_DEFAULT_USD,
        }),
        makeWhale({ resolvedBetsCount: MIN_RESOLVED_BETS - 1 }),
        Date.now(),
        { tradeEvPercent: 5 }
      )
    );

    expect(result.eligible).toBe(false);
    expect(result.matrix.passesStake).toBe(true);
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
