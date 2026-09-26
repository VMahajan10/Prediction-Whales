import { describe, expect, it } from "vitest";
import {
  buildProductFeedTradeEligibilityRow,
  buildProductFeedTradeEligibilityRows,
} from "@/lib/feed/persistProductFeedTradeEligibility";
import { PRODUCT_FEED_GATE_VERSION } from "@/lib/feed/productFeedGateVersion";
import {
  aggregateProductFeedEligibilityByUtcDay,
  isWithinProductFeedDoneTargetRange,
} from "@/lib/feed/productFeedEligibleDailyReport";
import { meetsFeedTradeEvThreshold } from "@/lib/feedQualification";
import type { WalletFeedQualification } from "@/lib/feedQualificationServer";
import { resolveRegistryWhaleIdentity } from "@/lib/feedQualificationServer";

function qualifiedWalletFor(wallet: string): WalletFeedQualification {
  return {
    qualified: true,
    hydrationState: "complete",
    resolvedBetsCount: 12,
    resolvedVolumeUSD: 50_000,
    historicalResolvedVolumeTrusted: true,
    historicalVolumeGateReason: null,
    historicalVolumeUsd: 50_000,
    historicalVolumeTrusted: true,
    historicalVolumeReason: null,
    productFeedWalletBlockReason: null,
    identity: resolveRegistryWhaleIdentity(wallet, null),
    avgStakeNotional: 500,
    avgEv: 0.05,
  };
}

describe("persistProductFeedTradeEligibility", () => {
  const baseTrade = {
    id: "trade-1",
    price: 0.5,
    size: 2000,
    title: "Will Bitcoin reach $100k by end of year?",
    outcome: "Yes",
    side: "BUY" as const,
    slug: "btc-100k",
    timestamp: 1_758_000_000,
  };

  it("records eligible trade with gate version", () => {
    const ev = meetsFeedTradeEvThreshold(5) ? 5 : 4;
    const row = buildProductFeedTradeEligibilityRow({
      trade: { ...baseTrade, proxyWallet: "0xabc" },
      tradeEvPercent: ev,
      qualification: qualifiedWalletFor("0xabc"),
    });
    expect(row.finalEligible).toBe(true);
    expect(row.productFeedGateVersion).toBe(PRODUCT_FEED_GATE_VERSION);
    expect(row.blockReason).toBeNull();
  });

  it("stores rejected trade with wallet block reason", () => {
    const row = buildProductFeedTradeEligibilityRow({
      trade: { ...baseTrade, id: "trade-rej", proxyWallet: "0xdef" },
      tradeEvPercent: 5,
      qualification: {
        ...qualifiedWalletFor("0xdef"),
        qualified: false,
        historicalResolvedVolumeTrusted: false,
        historicalVolumeTrusted: false,
        historicalVolumeGateReason: "historical_volume_below_minimum",
        productFeedWalletBlockReason: "historical_volume_below_minimum",
      },
    });
    expect(row.finalEligible).toBe(false);
    expect(row.walletGatePass).toBe(false);
    expect(row.blockReason).toBe("historical_volume_below_minimum");
  });

  it("duplicate evaluations collapse to one eligible count per day", () => {
    const ev = 5;
    const rows = buildProductFeedTradeEligibilityRows({
      trades: [
        { ...baseTrade, proxyWallet: "0xabc" },
        { ...baseTrade, proxyWallet: "0xabc" },
      ],
      tradeEvPercents: new Map([[baseTrade.id, ev]]),
      walletQualifications: { "0xabc": qualifiedWalletFor("0xabc") },
    });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.tradeId === baseTrade.id)).toBe(true);

    const dayKey = "2025-09-16";
    const tradedAt = new Date(`${dayKey}T15:00:00.000Z`);
    const rollup = aggregateProductFeedEligibilityByUtcDay(
      rows.map((r) => ({
        tradeId: r.tradeId,
        tradedAt,
        productFeedGateVersion: r.productFeedGateVersion,
        tradeStakePass: r.tradeStakePass,
        tradeEvPass: r.tradeEvPass,
        walletGatePass: r.walletGatePass,
        finalEligible: r.finalEligible,
        blockReason: r.blockReason,
        stakeUsd: r.stakeUsd,
        walletAddress: r.walletAddress,
      })),
      [dayKey]
    );
    expect(rollup[0].finalEligibleTrades).toBe(1);
  });

  it("excludes prior productFeedGateVersion from rollups", () => {
    const dayKey = "2025-09-16";
    const tradedAt = new Date(`${dayKey}T12:00:00.000Z`);
    const rollup = aggregateProductFeedEligibilityByUtcDay(
      [
        {
          tradeId: "old",
          tradedAt,
          productFeedGateVersion: "option1-authoritative-volume:legacy",
          tradeStakePass: true,
          tradeEvPass: true,
          walletGatePass: true,
          finalEligible: true,
          blockReason: null,
          stakeUsd: 1000,
          walletAddress: "0x1",
        },
        {
          tradeId: "new",
          tradedAt,
          productFeedGateVersion: PRODUCT_FEED_GATE_VERSION,
          tradeStakePass: true,
          tradeEvPass: true,
          walletGatePass: true,
          finalEligible: true,
          blockReason: null,
          stakeUsd: 1000,
          walletAddress: "0x2",
        },
      ],
      [dayKey]
    );
    expect(rollup[0].finalEligibleTrades).toBe(1);
  });

  it("target range: 3–5 in, 2 and 6 out", () => {
    expect(isWithinProductFeedDoneTargetRange(3)).toBe(true);
    expect(isWithinProductFeedDoneTargetRange(5)).toBe(true);
    expect(isWithinProductFeedDoneTargetRange(2)).toBe(false);
    expect(isWithinProductFeedDoneTargetRange(6)).toBe(false);
  });
});
