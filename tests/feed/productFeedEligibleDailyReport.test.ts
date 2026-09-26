import { describe, expect, it } from "vitest";
import {
  buildProductFeedSevenDaySummary,
  isWithinProductFeedDoneTargetRange,
  listFullUtcDayKeysEndingBefore,
  PRODUCT_FEED_GATE_VERSION,
  type ProductFeedDayRollup,
} from "@/lib/feed/productFeedEligibleDailyReport";

function day(eligible: number, dayKey: string): ProductFeedDayRollup {
  return {
    dayKey,
    tradeCandidates: eligible,
    stakeEvQualified: eligible,
    tradeLevelPassTrades: eligible,
    finalEligibleTrades: eligible,
    uniqueEligibleWallets: eligible,
    eligibleStakeUsd: eligible * 1000,
    rejectedByWalletGate: 0,
    walletGateRejectedTrades: 0,
    rejectionBreakdown: {},
    withinTargetRange: isWithinProductFeedDoneTargetRange(eligible),
  };
}

describe("productFeedEligibleDailyReport", () => {
  it("3,4,5 => within target range", () => {
    expect(isWithinProductFeedDoneTargetRange(3)).toBe(true);
    expect(isWithinProductFeedDoneTargetRange(4)).toBe(true);
    expect(isWithinProductFeedDoneTargetRange(5)).toBe(true);
  });

  it("2 => below range", () => {
    expect(isWithinProductFeedDoneTargetRange(2)).toBe(false);
  });

  it("6 => outside strict target range", () => {
    expect(isWithinProductFeedDoneTargetRange(6)).toBe(false);
  });

  it("excludes partial current day from last7FullDays helper", () => {
    const keys = listFullUtcDayKeysEndingBefore("2026-09-23", 7);
    expect(keys).toHaveLength(7);
    expect(keys[0]).toBe("2026-09-16");
    expect(keys[6]).toBe("2026-09-22");
    expect(keys).not.toContain("2026-09-23");
  });

  it("7 consecutive qualifying full days => done true", () => {
    const last7 = [
      day(3, "2026-09-16"),
      day(4, "2026-09-17"),
      day(5, "2026-09-18"),
      day(3, "2026-09-19"),
      day(4, "2026-09-20"),
      day(5, "2026-09-21"),
      day(3, "2026-09-22"),
    ];
    const summary = buildProductFeedSevenDaySummary({ last7FullDays: last7 });
    expect(summary.doneCriteriaMet).toBe(true);
    expect(summary.consecutiveDaysWithinTargetRange).toBe(7);
  });

  it("6 qualifying + 1 bad day => done false", () => {
    const last7 = [
      day(3, "2026-09-16"),
      day(4, "2026-09-17"),
      day(5, "2026-09-18"),
      day(3, "2026-09-19"),
      day(4, "2026-09-20"),
      day(5, "2026-09-21"),
      day(2, "2026-09-22"),
    ];
    const summary = buildProductFeedSevenDaySummary({ last7FullDays: last7 });
    expect(summary.doneCriteriaMet).toBe(false);
    expect(summary.daysWithinTargetRange).toBe(6);
  });

  it("gate version matches authoritative at-trade-time epoch", () => {
    expect(PRODUCT_FEED_GATE_VERSION).toBe("authoritative-volume-option1-v1");
  });
});
