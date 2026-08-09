import { describe, expect, it } from "vitest";
import {
  applyUnverifiedWhaleQueueTag,
  BELOW_EV_THRESHOLD,
  BELOW_RESOLVED_BETS,
  evaluatePostQueueCredibilityGate,
  evaluatePostQueueMarketTranslationGate,
  evaluatePostQueueSourceGate,
  evaluateResolvedBetsCredibilityFloor,
  isAllowUnregisteredWalletsInShadow,
  isPostQueueSourceAllowed,
  KALSHI_PUBLIC_POSTING_DISABLED,
  KALSHI_PUBLIC_POSTING_DISABLED_REASON,
  SHADOW_UNREGISTERED_STAKE_BYPASS_USD,
  shouldApplyUnverifiedWhaleCredibilityBypass,
  shouldDeferCredibilityForUnverifiedWhale,
  STAKE_TOO_LOW,
  UNVERIFIED_WHALE_MIN_TRADE_EV_DECIMAL,
  UNVERIFIED_WHALE_QUEUE_TAG,
  UNVERIFIED_WHALE_STAKE_FLOOR_USD,
} from "@/lib/x-agent/postQueueGates";
import {
  CREDIBILITY_CONFIG,
  MIN_AVG_EV_THRESHOLD,
  MIN_STAKE_THRESHOLD,
} from "@/lib/feedQualification";

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

describe("postQueueGates", () => {
  it("hardcodes Kalshi public posting as disabled", () => {
    expect(KALSHI_PUBLIC_POSTING_DISABLED).toBe(true);
  });

  it("allows only polymarket trades through the post-queue source gate", () => {
    expect(isPostQueueSourceAllowed("polymarket")).toBe(true);
    expect(isPostQueueSourceAllowed("kalshi")).toBe(false);
  });

  it("rejects kalshi with KALSHI_PUBLIC_POSTING_DISABLED", () => {
    const result = evaluatePostQueueSourceGate({
      source: "kalshi",
      tradeId: "kalshi-trade-1",
    });

    expect(result.passed).toBe(false);
    expect(result.reason).toBe(KALSHI_PUBLIC_POSTING_DISABLED_REASON);
  });

  it("passes polymarket trades", () => {
    const result = evaluatePostQueueSourceGate({
      source: "polymarket",
      tradeId: "pm-trade-1",
    });

    expect(result.passed).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("rejects trades below the credibility stake threshold", () => {
    const result = evaluatePostQueueCredibilityGate({
      tradeId: "trade-stake-low",
      stakeNotional: MIN_STAKE_THRESHOLD - 1,
      walletAvgEv: MIN_AVG_EV_THRESHOLD + 0.01,
      resolvedBetCount: CREDIBILITY_CONFIG.MIN_RESOLVED_BETS,
    });

    expect(result.passed).toBe(false);
    expect(result.reason).toBe(STAKE_TOO_LOW);
  });

  it("rejects wallets below the resolved-bets threshold", () => {
    const result = withStrictCredibilityGates(() =>
      evaluatePostQueueCredibilityGate({
        tradeId: "trade-resolved-low",
        stakeNotional: MIN_STAKE_THRESHOLD,
        walletAvgEv: MIN_AVG_EV_THRESHOLD,
        resolvedBetCount: CREDIBILITY_CONFIG.MIN_RESOLVED_BETS - 1,
      })
    );

    expect(result.passed).toBe(false);
    expect(result.reason).toBe(BELOW_RESOLVED_BETS);
  });

  it("rejects wallets below the avg EV threshold", () => {
    const result = withStrictCredibilityGates(() =>
      evaluatePostQueueCredibilityGate({
        tradeId: "trade-ev-low",
        stakeNotional: MIN_STAKE_THRESHOLD,
        walletAvgEv: MIN_AVG_EV_THRESHOLD - 0.001,
        resolvedBetCount: CREDIBILITY_CONFIG.MIN_RESOLVED_BETS,
      })
    );

    expect(result.passed).toBe(false);
    expect(result.reason).toBe(BELOW_EV_THRESHOLD);
  });

  it("rejects negative wallet avg EV", () => {
    const result = withStrictCredibilityGates(() =>
      evaluatePostQueueCredibilityGate({
        tradeId: "trade-ev-negative",
        stakeNotional: MIN_STAKE_THRESHOLD,
        walletAvgEv: -0.011,
        resolvedBetCount: CREDIBILITY_CONFIG.MIN_RESOLVED_BETS,
      })
    );

    expect(result.passed).toBe(false);
    expect(result.reason).toBe(BELOW_EV_THRESHOLD);
  });

  it("passes when stake, resolved bets, and wallet avg EV meet thresholds", () => {
    const result = evaluatePostQueueCredibilityGate({
      tradeId: "trade-qualified",
      stakeNotional: MIN_STAKE_THRESHOLD,
      walletAvgEv: MIN_AVG_EV_THRESHOLD,
      resolvedBetCount: CREDIBILITY_CONFIG.MIN_RESOLVED_BETS,
    });

    expect(result.passed).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("rejects missing resolved bets in shadow even when stake >= $500", () => {
    const previous = process.env.ALLOW_UNREGISTERED_WALLETS_IN_SHADOW;
    process.env.ALLOW_UNREGISTERED_WALLETS_IN_SHADOW = "true";

    try {
      const result = evaluatePostQueueCredibilityGate({
        tradeId: "trade-shadow-missing-bets",
        stakeNotional: SHADOW_UNREGISTERED_STAKE_BYPASS_USD,
        walletAvgEv: null,
        resolvedBetCount: null,
      });

      expect(result.passed).toBe(false);
      expect(result.reason).toBe(BELOW_RESOLVED_BETS);
      expect(isAllowUnregisteredWalletsInShadow()).toBe(true);
    } finally {
      if (previous === undefined) {
        delete process.env.ALLOW_UNREGISTERED_WALLETS_IN_SHADOW;
      } else {
        process.env.ALLOW_UNREGISTERED_WALLETS_IN_SHADOW = previous;
      }
    }
  });

  it("bypasses only wallet avg EV in shadow when resolved bets meet threshold", () => {
    const previous = process.env.ALLOW_UNREGISTERED_WALLETS_IN_SHADOW;
    process.env.ALLOW_UNREGISTERED_WALLETS_IN_SHADOW = "true";

    try {
      const result = evaluatePostQueueCredibilityGate({
        tradeId: "trade-shadow-ev-bypass",
        stakeNotional: SHADOW_UNREGISTERED_STAKE_BYPASS_USD,
        walletAvgEv: null,
        resolvedBetCount: CREDIBILITY_CONFIG.MIN_RESOLVED_BETS,
      });

      expect(result.passed).toBe(true);
    } finally {
      if (previous === undefined) {
        delete process.env.ALLOW_UNREGISTERED_WALLETS_IN_SHADOW;
      } else {
        process.env.ALLOW_UNREGISTERED_WALLETS_IN_SHADOW = previous;
      }
    }
  });

  it("passes anonymous wallets without resolved bets", () => {
    const result = withStrictCredibilityGates(() =>
      evaluatePostQueueCredibilityGate({
        tradeId: "trade-anonymous",
        walletAddress: "0x0000000000000000000000000000000000000000",
        stakeNotional: MIN_STAKE_THRESHOLD,
        walletAvgEv: null,
        resolvedBetCount: 0,
      })
    );

    expect(result.passed).toBe(true);
    expect(result.unverifiedWhale).toBe(true);
  });

  it("bypasses resolved bets for high-stake unindexed wallets in production", () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousShadow = process.env.ALLOW_UNREGISTERED_WALLETS_IN_SHADOW;
    const previousUnindexed = process.env.ALLOW_UNINDEXED_WALLETS;
    process.env.NODE_ENV = "production";
    process.env.ALLOW_UNREGISTERED_WALLETS_IN_SHADOW = "false";
    process.env.ALLOW_UNINDEXED_WALLETS = "false";

    try {
      const result = evaluateResolvedBetsCredibilityFloor({
        tradeId: "trade-prod-unindexed",
        walletAddress: "0xabc123",
        stakeNotional: UNVERIFIED_WHALE_STAKE_FLOOR_USD,
        resolvedBetCount: 0,
        whaleNotInRegistry: true,
      });

      expect(result.passed).toBe(true);
      expect(result.unverifiedWhale).toBe(true);
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
    }
  });

  it("rejects high-stake wallets with zero resolved bets when indexed", () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousShadow = process.env.ALLOW_UNREGISTERED_WALLETS_IN_SHADOW;
    const previousUnindexed = process.env.ALLOW_UNINDEXED_WALLETS;
    process.env.NODE_ENV = "production";
    process.env.ALLOW_UNREGISTERED_WALLETS_IN_SHADOW = "false";
    process.env.ALLOW_UNINDEXED_WALLETS = "false";

    try {
      const result = evaluatePostQueueCredibilityGate({
        tradeId: "trade-prod-unindexed",
        stakeNotional: SHADOW_UNREGISTERED_STAKE_BYPASS_USD,
        walletAvgEv: null,
        resolvedBetCount: 0,
        whaleNotInRegistry: false,
      });

      expect(result.passed).toBe(false);
      expect(result.reason).toBe(BELOW_RESOLVED_BETS);
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
    }
  });

  it("rejects sub-bypass stake with zero resolved bets in production", () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousShadow = process.env.ALLOW_UNREGISTERED_WALLETS_IN_SHADOW;
    const previousUnindexed = process.env.ALLOW_UNINDEXED_WALLETS;
    process.env.NODE_ENV = "production";
    process.env.ALLOW_UNREGISTERED_WALLETS_IN_SHADOW = "false";
    process.env.ALLOW_UNINDEXED_WALLETS = "false";

    try {
      const result = evaluatePostQueueCredibilityGate({
        tradeId: "trade-prod-reject",
        stakeNotional: SHADOW_UNREGISTERED_STAKE_BYPASS_USD - 1,
        walletAvgEv: null,
        resolvedBetCount: 0,
      });

      expect(result.passed).toBe(false);
      expect(result.reason).toBe(BELOW_RESOLVED_BETS);
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
    }
  });

  it("rejects missing resolved bets even when ALLOW_UNINDEXED_WALLETS is true", () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousUnindexed = process.env.ALLOW_UNINDEXED_WALLETS;
    process.env.NODE_ENV = "production";
    process.env.ALLOW_UNINDEXED_WALLETS = "true";
    process.env.ALLOW_UNREGISTERED_WALLETS_IN_SHADOW = "false";

    try {
      const result = evaluatePostQueueCredibilityGate({
        tradeId: "trade-unindexed-reject",
        stakeNotional: SHADOW_UNREGISTERED_STAKE_BYPASS_USD,
        walletAvgEv: null,
        resolvedBetCount: null,
      });

      expect(result.passed).toBe(false);
      expect(result.reason).toBe(BELOW_RESOLVED_BETS);
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
      if (previousUnindexed === undefined) {
        delete process.env.ALLOW_UNINDEXED_WALLETS;
      } else {
        process.env.ALLOW_UNINDEXED_WALLETS = previousUnindexed;
      }
    }
  });

  it("bypasses resolved bets for anonymous wallets", () => {
    const result = evaluateResolvedBetsCredibilityFloor({
      tradeId: "trade-anonymous-zero",
      walletAddress: "0x0000000000000000000000000000000000000000",
      resolvedBetCount: 0,
      stakeNotional: MIN_STAKE_THRESHOLD,
    });

    expect(result.passed).toBe(true);
    expect(result.unverifiedWhale).toBe(true);
  });

  it("logs and rejects wallets with zero resolved bets after hydration", () => {
    const result = evaluateResolvedBetsCredibilityFloor({
      tradeId: "trade-zero-bets",
      walletAddress: "0xabc123",
      resolvedBetCount: 0,
    });

    expect(result.passed).toBe(false);
    expect(result.reason).toBe(BELOW_RESOLVED_BETS);
  });

  it("uses title/outcome fallback instead of failing market translation", () => {
    const result = evaluatePostQueueMarketTranslationGate({
      tradeId: "trade-fallback-translation",
      market: { title: "Obscure prop market without mapping?" },
      position: { outcome: "Yes", side: "BUY" },
    });

    expect(result.passed).toBe(true);
    expect(result.translation).toEqual({
      backingLabel: "bought yes",
      sideName: "Obscure prop market without mapping",
      exitByLabel: undefined,
    });
  });

  it("defers credibility for high-stake wallets missing from registry", () => {
    expect(
      shouldDeferCredibilityForUnverifiedWhale({
        whaleNotInRegistry: true,
        whale: null,
        stakeNotional: UNVERIFIED_WHALE_STAKE_FLOOR_USD,
      })
    ).toBe(true);
    expect(
      shouldDeferCredibilityForUnverifiedWhale({
        whaleNotInRegistry: true,
        whale: null,
        stakeNotional: UNVERIFIED_WHALE_STAKE_FLOOR_USD - 1,
      })
    ).toBe(false);
  });

  it("bypasses credibility for unregistered whales with stake >= $1000 and EV >= 3%", () => {
    expect(
      shouldApplyUnverifiedWhaleCredibilityBypass({
        whale: null,
        stakeNotional: UNVERIFIED_WHALE_STAKE_FLOOR_USD,
        calculatedEvDecimal: UNVERIFIED_WHALE_MIN_TRADE_EV_DECIMAL,
      })
    ).toBe(true);

    const result = evaluatePostQueueCredibilityGate({
      tradeId: "trade-unverified-whale",
      walletAddress: "0xabc123",
      stakeNotional: UNVERIFIED_WHALE_STAKE_FLOOR_USD,
      walletAvgEv: null,
      resolvedBetCount: 0,
      calculatedEvDecimal: UNVERIFIED_WHALE_MIN_TRADE_EV_DECIMAL,
      whaleNotInRegistry: true,
      whale: null,
    });

    expect(result.passed).toBe(true);
    expect(result.unverifiedWhale).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("rejects unregistered whales below the unverified EV floor", () => {
    const result = withStrictCredibilityGates(() =>
      evaluatePostQueueCredibilityGate({
        tradeId: "trade-unverified-ev-low",
        walletAddress: "0xabc123",
        stakeNotional: UNVERIFIED_WHALE_STAKE_FLOOR_USD,
        walletAvgEv: null,
        resolvedBetCount: 0,
        calculatedEvDecimal: UNVERIFIED_WHALE_MIN_TRADE_EV_DECIMAL - 0.001,
        whaleNotInRegistry: true,
        whale: null,
      })
    );

    expect(result.passed).toBe(false);
    expect(result.reason).toBe(BELOW_RESOLVED_BETS);
  });

  it("appends the unverified_whale queue tag once", () => {
    expect(applyUnverifiedWhaleQueueTag("alpha")).toBe(
      `alpha|${UNVERIFIED_WHALE_QUEUE_TAG}`
    );
    expect(
      applyUnverifiedWhaleQueueTag(`alpha|${UNVERIFIED_WHALE_QUEUE_TAG}`)
    ).toBe(`alpha|${UNVERIFIED_WHALE_QUEUE_TAG}`);
  });
});
