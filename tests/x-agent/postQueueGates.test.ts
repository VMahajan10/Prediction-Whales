import { describe, expect, it } from "vitest";
import {
  BELOW_EV_THRESHOLD,
  evaluatePostQueueCredibilityGate,
  evaluatePostQueueSourceGate,
  isPostQueueSourceAllowed,
  KALSHI_PUBLIC_POSTING_DISABLED,
  STAKE_TOO_LOW,
} from "@/lib/x-agent/postQueueGates";
import {
  MIN_AVG_EV_THRESHOLD,
  MIN_STAKE_THRESHOLD,
} from "@/lib/x-agent/gateMetrics";

describe("postQueueGates", () => {
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
    expect(result.reason).toBe(KALSHI_PUBLIC_POSTING_DISABLED);
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
    });

    expect(result.passed).toBe(false);
    expect(result.reason).toBe(STAKE_TOO_LOW);
  });

  it("rejects wallets below the avg EV threshold", () => {
    const result = evaluatePostQueueCredibilityGate({
      tradeId: "trade-ev-low",
      stakeNotional: MIN_STAKE_THRESHOLD,
      walletAvgEv: MIN_AVG_EV_THRESHOLD - 0.001,
    });

    expect(result.passed).toBe(false);
    expect(result.reason).toBe(BELOW_EV_THRESHOLD);
  });

  it("rejects negative wallet avg EV", () => {
    const result = evaluatePostQueueCredibilityGate({
      tradeId: "trade-ev-negative",
      stakeNotional: MIN_STAKE_THRESHOLD,
      walletAvgEv: -0.011,
    });

    expect(result.passed).toBe(false);
    expect(result.reason).toBe(BELOW_EV_THRESHOLD);
  });

  it("passes when stake and wallet avg EV meet thresholds", () => {
    const result = evaluatePostQueueCredibilityGate({
      tradeId: "trade-qualified",
      stakeNotional: MIN_STAKE_THRESHOLD,
      walletAvgEv: MIN_AVG_EV_THRESHOLD,
    });

    expect(result.passed).toBe(true);
    expect(result.reason).toBeUndefined();
  });
});
