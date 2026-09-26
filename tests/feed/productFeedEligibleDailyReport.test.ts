import { describe, expect, it } from "vitest";
import {
  buildProductFeedObservationWindow,
  buildProductFeedSevenDaySummary,
  isWithinProductFeedDoneTargetRange,
  listFullUtcDayKeysEndingBefore,
  listFullyObservedUtcDayKeysBeforeToday,
  PRODUCT_FEED_GATE_VERSION,
  resolveFirstFullObservedDayKey,
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

const TRACKING_EPOCH = new Date("2026-09-26T20:33:34.515Z");

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

  it("epoch partial day excluded; first full day is next UTC midnight", () => {
    expect(resolveFirstFullObservedDayKey(TRACKING_EPOCH)).toBe("2026-09-27");
    const keys = listFullyObservedUtcDayKeysBeforeToday({
      firstFullObservedDayKey: "2026-09-27",
      todayKey: "2026-09-27",
    });
    expect(keys).toEqual([]);
    const keysBefore28 = listFullyObservedUtcDayKeysBeforeToday({
      firstFullObservedDayKey: "2026-09-27",
      todayKey: "2026-09-28",
    });
    expect(keysBefore28).toEqual(["2026-09-27"]);
  });

  it("pre-epoch calendar days are not in fully observed window", () => {
    const window = buildProductFeedObservationWindow({
      trackingEpochStartedAt: TRACKING_EPOCH,
      todayKey: "2026-09-27",
    });
    expect(window.firstFullObservedDay).toBe("2026-09-27");
    expect(window.fullDaysObserved).toBe(0);
    expect(window.last7FullDayKeys).toEqual([]);
    expect(window.observationStatus).toBe("INSUFFICIENT_FULL_DAYS");
    expect(window.fullyObservedDayKeys).not.toContain("2026-09-26");
    expect(window.fullyObservedDayKeys).not.toContain("2026-09-19");
  });

  it("fewer than 7 full observed days cannot satisfy done criteria", () => {
    const window = buildProductFeedObservationWindow({
      trackingEpochStartedAt: TRACKING_EPOCH,
      todayKey: "2026-10-02",
    });
    expect(window.fullDaysObserved).toBe(5);
    const summary = buildProductFeedSevenDaySummary({
      last7FullDays: window.last7FullDayKeys.map((key) => day(4, key)),
      observationStatus: window.observationStatus,
    });
    expect(summary.doneCriteriaMet).toBe(false);
    expect(summary.observationStatus).toBe("INSUFFICIENT_FULL_DAYS");
    expect(summary.fullDaysObserved).toBe(5);
  });

  it("7 consecutive qualifying full observed days => done true", () => {
    const last7 = [
      day(3, "2026-09-16"),
      day(4, "2026-09-17"),
      day(5, "2026-09-18"),
      day(3, "2026-09-19"),
      day(4, "2026-09-20"),
      day(5, "2026-09-21"),
      day(3, "2026-09-22"),
    ];
    const summary = buildProductFeedSevenDaySummary({
      last7FullDays: last7,
      observationStatus: "READY",
    });
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
    const summary = buildProductFeedSevenDaySummary({
      last7FullDays: last7,
      observationStatus: "READY",
    });
    expect(summary.doneCriteriaMet).toBe(false);
    expect(summary.daysWithinTargetRange).toBe(6);
  });

  it(">5 eligible on any day fails done criterion", () => {
    const last7 = [
      day(3, "2026-09-16"),
      day(4, "2026-09-17"),
      day(5, "2026-09-18"),
      day(3, "2026-09-19"),
      day(4, "2026-09-20"),
      day(5, "2026-09-21"),
      day(6, "2026-09-22"),
    ];
    const summary = buildProductFeedSevenDaySummary({
      last7FullDays: last7,
      observationStatus: "READY",
    });
    expect(summary.doneCriteriaMet).toBe(false);
  });

  it("gate version matches authoritative at-trade-time epoch", () => {
    expect(PRODUCT_FEED_GATE_VERSION).toBe("authoritative-volume-option1-v1");
  });
});
