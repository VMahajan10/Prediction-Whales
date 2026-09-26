import { describe, expect, it } from "vitest";
import {
  isQualifiedTraderForProductFeed,
  passesPolymarketFeedTraderGate,
  passesPolymarketTraderCredibilityForFeed,
  resolveProductFeedWalletBlockReason,
  MIN_PRODUCT_FEED_RESOLVED_VOLUME_USD,
} from "@/lib/feedQualification";
import {
  coerceFiniteResolvedVolumeUsd,
  resolveHistoricalVolumeForWalletMetricRows,
  resolveProductFeedHistoricalVolumeFromIndexedRow,
} from "@/lib/feed/productFeedHistoricalVolume";
import { evaluatePostQueueCredibilityGate } from "@/lib/x-agent/postQueueGates";
import { evaluateLiveFeedTradeGate } from "@/lib/feedGate";

function trustedVolume(volumeUsd: number) {
  return {
    resolvedVolumeUSD: volumeUsd,
    historicalResolvedVolumeTrusted: true,
    historicalVolumeGateReason: null,
  };
}

function row(volumeUsd: unknown, valid = true) {
  return resolveProductFeedHistoricalVolumeFromIndexedRow({
    credibilityMetricsValid: valid,
    resolvedVolumeUsd: volumeUsd,
  });
}

describe("Option 1 authoritative historical volume resolution", () => {
  it("A: no metrics row => historical_volume_unavailable", () => {
    expect(row(null).historicalVolumeGateReason).toBe(
      "historical_volume_unavailable"
    );
    expect(row(undefined).historicalResolvedVolumeTrusted).toBe(false);
  });

  it("B: credibility_metrics_valid false => historical_volume_unavailable", () => {
    const resolution = row(50_000, false);
    expect(resolution.historicalVolumeGateReason).toBe(
      "historical_volume_unavailable"
    );
    expect(resolution.historicalResolvedVolumeTrusted).toBe(false);
  });

  it("C: wrong metric_version is excluded at fetch layer (no row => unavailable)", () => {
    expect(row(null).historicalVolumeGateReason).toBe(
      "historical_volume_unavailable"
    );
  });

  it("D: resolved_volume_usd null => historical_volume_unavailable", () => {
    expect(row(null).historicalVolumeGateReason).toBe(
      "historical_volume_unavailable"
    );
    expect(
      resolveProductFeedHistoricalVolumeFromIndexedRow({
        credibilityMetricsValid: true,
        resolvedVolumeUsd: null,
      }).historicalVolumeGateReason
    ).toBe("historical_volume_unavailable");
  });

  it("duplicate metric rows for one wallet fail closed as unavailable", () => {
    const resolution = resolveHistoricalVolumeForWalletMetricRows([
      {
        walletAddress: "0xabc",
        credibilityMetricsValid: true,
        resolvedVolumeUsd: 500,
      },
      {
        walletAddress: "0xabc",
        credibilityMetricsValid: true,
        resolvedVolumeUsd: 600,
      },
    ]);
    expect(resolution.historicalVolumeGateReason).toBe(
      "historical_volume_unavailable"
    );
  });

  it("E: non-finite / unparsable volume => historical_volume_unavailable", () => {
    expect(coerceFiniteResolvedVolumeUsd(null)).toBeNull();
    expect(coerceFiniteResolvedVolumeUsd(undefined)).toBeNull();
    expect(coerceFiniteResolvedVolumeUsd(Number.NaN)).toBeNull();
    expect(coerceFiniteResolvedVolumeUsd(Number.POSITIVE_INFINITY)).toBeNull();
    expect(coerceFiniteResolvedVolumeUsd(Number.NEGATIVE_INFINITY)).toBeNull();
    expect(coerceFiniteResolvedVolumeUsd("not-a-number")).toBeNull();
    expect(row(Number.NaN).historicalVolumeGateReason).toBe(
      "historical_volume_unavailable"
    );
    expect(row("abc").historicalVolumeGateReason).toBe(
      "historical_volume_unavailable"
    );
    expect(row("500").status).toBe("trusted");
  });

  it("F: resolved_volume_usd = 299.99 => historical_volume_below_minimum", () => {
    const resolution = row(299.99);
    expect(resolution.historicalVolumeGateReason).toBe(
      "historical_volume_below_minimum"
    );
    expect(resolution.resolvedVolumeUSD).toBe(299.99);
  });

  it("G: resolved_volume_usd = 300 => passes volume requirement", () => {
    const resolution = row(300);
    expect(resolution.status).toBe("trusted");
    expect(resolution.historicalResolvedVolumeTrusted).toBe(true);
    expect(
      isQualifiedTraderForProductFeed({
        resolvedBetsCount: 10,
        ...trustedVolume(300),
      })
    ).toBe(true);
  });

  it("H: resolved_volume_usd > 300 => passes volume requirement", () => {
    expect(row(301).status).toBe("trusted");
  });

  it("I: huge avgStakeNotional but unavailable metrics => unavailable (no proxy)", () => {
    expect(
      isQualifiedTraderForProductFeed({
        resolvedBetsCount: 10,
        avgStakeNotional: 1_000_000,
        historicalResolvedVolumeTrusted: false,
        historicalVolumeGateReason: "historical_volume_unavailable",
        resolvedVolumeUSD: null,
      })
    ).toBe(false);
    expect(
      resolveProductFeedWalletBlockReason({
        hydrationState: "complete",
        resolvedBetsCount: 10,
        historicalResolvedVolumeTrusted: false,
        historicalVolumeGateReason: "historical_volume_unavailable",
      })
    ).toBe("historical_volume_unavailable");
  });

  it("J: proxy below 300 but authoritative >= 300 => PASS", () => {
    expect(
      isQualifiedTraderForProductFeed({
        resolvedBetsCount: 10,
        avgStakeNotional: 1,
        ...trustedVolume(500),
      })
    ).toBe(true);
  });

  it("K: proxy >= 300 but authoritative < 300 => historical_volume_below_minimum", () => {
    const resolution = row(250);
    expect(resolution.historicalVolumeGateReason).toBe(
      "historical_volume_below_minimum"
    );
    expect(
      isQualifiedTraderForProductFeed({
        resolvedBetsCount: 10,
        avgStakeNotional: 100,
        historicalResolvedVolumeTrusted: false,
        historicalVolumeGateReason: "historical_volume_below_minimum",
        resolvedVolumeUSD: 250,
      })
    ).toBe(false);
  });

  it("L: very low wallet avg_ev with authoritative requirements => product feed PASS", () => {
    const stats = {
      resolvedBetsCount: 12,
      avgEv: -0.5,
      avgStakeNotional: 0,
      ...trustedVolume(400),
    };
    expect(isQualifiedTraderForProductFeed(stats)).toBe(true);
    expect(
      passesPolymarketFeedTraderGate("0xabc", {
        hydrationState: "complete",
        ...stats,
      })
    ).toBe(true);
    expect(
      evaluateLiveFeedTradeGate({
        stakeUsd: 600,
        title: "Will Bitcoin reach $100k?",
        tradeEvPercent: 4,
      }).passed
    ).toBe(true);
  });

  it("M: same low avg_ev wallet fails X-agent post-queue credibility (unchanged)", () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const result = evaluatePostQueueCredibilityGate({
        tradeId: "t1",
        stakeNotional: 600,
        walletAddress: "0xabc",
        walletAvgEv: -0.5,
        resolvedBetCount: 10,
        whale: {
          resolvedBetsCount: 10,
          avgEv: -0.5,
          winRate: 0.5,
          avgStakeNotional: 50,
        },
      });
      expect(result.passed).toBe(false);
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
    }
  });

  it("count 9 with valid volume fails", () => {
    expect(
      isQualifiedTraderForProductFeed({
        resolvedBetsCount: 9,
        ...trustedVolume(500),
      })
    ).toBe(false);
  });

  it("trusted volume at MIN-1 fails trader gate", () => {
    expect(
      isQualifiedTraderForProductFeed({
        resolvedBetsCount: 10,
        historicalResolvedVolumeTrusted: false,
        historicalVolumeGateReason: "historical_volume_below_minimum",
        resolvedVolumeUSD: MIN_PRODUCT_FEED_RESOLVED_VOLUME_USD - 1,
      })
    ).toBe(false);
  });

  it("passesPolymarketTraderCredibilityForFeed requires hydration complete", () => {
    expect(
      passesPolymarketTraderCredibilityForFeed({
        hydrationState: "pending",
        resolvedBetsCount: 10,
        ...trustedVolume(500),
      })
    ).toBe(false);
  });
});
