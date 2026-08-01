import { describe, expect, it } from "vitest";
import {
  BELOW_EV_THRESHOLD,
  BELOW_RESOLVED_BETS,
  evaluatePostQueueCredibilityGate,
  evaluatePostQueueMarketTranslationGate,
  evaluatePostQueueSourceGate,
  isAllowUnregisteredWalletsInShadow,
  isPostQueueSourceAllowed,
  KALSHI_PUBLIC_POSTING_DISABLED,
  KALSHI_PUBLIC_POSTING_DISABLED_REASON,
  SHADOW_UNREGISTERED_STAKE_BYPASS_USD,
  STAKE_TOO_LOW,
} from "@/lib/x-agent/postQueueGates";
import {
  CREDIBILITY_CONFIG,
  MIN_AVG_EV_THRESHOLD,
  MIN_STAKE_THRESHOLD,
} from "@/lib/feedQualification";

function withStrictCredibilityGates<T>(fn: () => T): T {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousShadow = process.env.ALLOW_UNREGISTERED_WALLETS_IN_SHADOW;
  process.env.NODE_ENV = "production";
  process.env.ALLOW_UNREGISTERED_WALLETS_IN_SHADOW = "false";

  try {
    return fn();
  } finally {
    process.env.NODE_ENV = previousNodeEnv;
    if (previousShadow === undefined) {
      delete process.env.ALLOW_UNREGISTERED_WALLETS_IN_SHADOW;
    } else {
      process.env.ALLOW_UNREGISTERED_WALLETS_IN_SHADOW = previousShadow;
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

  it("bypasses missing registry stats in shadow when stake >= $250", () => {
    const previous = process.env.ALLOW_UNREGISTERED_WALLETS_IN_SHADOW;
    process.env.ALLOW_UNREGISTERED_WALLETS_IN_SHADOW = "true";

    try {
      const result = evaluatePostQueueCredibilityGate({
        tradeId: "trade-shadow-bypass",
        stakeNotional: SHADOW_UNREGISTERED_STAKE_BYPASS_USD,
        walletAvgEv: null,
        resolvedBetCount: null,
      });

      expect(result.passed).toBe(true);
      expect(isAllowUnregisteredWalletsInShadow()).toBe(true);
    } finally {
      if (previous === undefined) {
        delete process.env.ALLOW_UNREGISTERED_WALLETS_IN_SHADOW;
      } else {
        process.env.ALLOW_UNREGISTERED_WALLETS_IN_SHADOW = previous;
      }
    }
  });

  it("rejects missing registry stats in production shadow-off mode", () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousShadow = process.env.ALLOW_UNREGISTERED_WALLETS_IN_SHADOW;
    process.env.NODE_ENV = "production";
    process.env.ALLOW_UNREGISTERED_WALLETS_IN_SHADOW = "false";

    try {
      const result = evaluatePostQueueCredibilityGate({
        tradeId: "trade-prod-reject",
        stakeNotional: SHADOW_UNREGISTERED_STAKE_BYPASS_USD,
        walletAvgEv: null,
        resolvedBetCount: null,
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
    }
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
});
