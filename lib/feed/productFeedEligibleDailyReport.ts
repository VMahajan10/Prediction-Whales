import { feedMetricsDayKeyUtc } from "@/lib/feedMetricsCore";
import { PRODUCT_FEED_GATE_VERSION } from "@/lib/feed/productFeedGateVersion";
import type { ProductFeedWalletBlockReason } from "@/lib/feedQualification";

export { PRODUCT_FEED_GATE_VERSION };

export const PRODUCT_FEED_ELIGIBLE_DAY_BOUNDARY =
  "UTC calendar day (YYYY-MM-DD via feedMetricsDayKeyUtc)";

export const PRODUCT_FEED_DONE_MIN_ELIGIBLE_PER_DAY = 3;
export const PRODUCT_FEED_DONE_MAX_ELIGIBLE_PER_DAY = 5;
export const PRODUCT_FEED_DONE_CONSECUTIVE_FULL_DAYS = 7;

const WALLET_BLOCK_REASONS: ReadonlySet<string> = new Set([
  "wallet_not_in_registry",
  "hydration_incomplete",
  "insufficient_resolved_bets_count",
  "historical_volume_unavailable",
  "historical_volume_below_minimum",
  "other",
]);

export function tradeDayKeyUtc(tradedAt: Date): string {
  return feedMetricsDayKeyUtc(tradedAt);
}

export function isWithinProductFeedDoneTargetRange(eligibleTrades: number): boolean {
  return (
    eligibleTrades >= PRODUCT_FEED_DONE_MIN_ELIGIBLE_PER_DAY &&
    eligibleTrades <= PRODUCT_FEED_DONE_MAX_ELIGIBLE_PER_DAY
  );
}

export function listFullUtcDayKeysEndingBefore(
  todayKey: string,
  count: number
): string[] {
  const end = parseUtcDayKey(todayKey);
  const keys: string[] = [];
  for (let i = count; i >= 1; i -= 1) {
    const d = new Date(end.getTime() - i * 24 * 60 * 60 * 1000);
    keys.push(feedMetricsDayKeyUtc(d));
  }
  return keys;
}

function parseUtcDayKey(dayKey: string): Date {
  return new Date(`${dayKey}T12:00:00.000Z`);
}

function utcDayStart(dayKey: string): Date {
  return new Date(`${dayKey}T00:00:00.000Z`);
}

function addUtcCalendarDays(dayKey: string, days: number): string {
  const start = utcDayStart(dayKey);
  return feedMetricsDayKeyUtc(
    new Date(start.getTime() + days * 24 * 60 * 60 * 1000)
  );
}

/**
 * First UTC calendar day with complete instrumentation coverage.
 * The epoch day is partial when tracking begins after that day's 00:00 UTC.
 */
export function resolveFirstFullObservedDayKey(
  trackingEpochStartedAt: Date
): string {
  const epochDayKey = tradeDayKeyUtc(trackingEpochStartedAt);
  const dayStart = utcDayStart(epochDayKey);
  if (trackingEpochStartedAt.getTime() <= dayStart.getTime()) {
    return epochDayKey;
  }
  return addUtcCalendarDays(epochDayKey, 1);
}

/** Fully observed UTC days from firstFullObservedDay up to (not including) todayKey. */
export function listFullyObservedUtcDayKeysBeforeToday(input: {
  firstFullObservedDayKey: string;
  todayKey: string;
}): string[] {
  const keys: string[] = [];
  const todayStart = utcDayStart(input.todayKey).getTime();
  let cursor = utcDayStart(input.firstFullObservedDayKey);
  while (cursor.getTime() < todayStart) {
    keys.push(feedMetricsDayKeyUtc(cursor));
    cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
  }
  return keys;
}

export function selectLastFullyObservedDaysForStability(
  fullyObservedDayKeys: string[],
  count = PRODUCT_FEED_DONE_CONSECUTIVE_FULL_DAYS
): string[] {
  if (fullyObservedDayKeys.length <= count) {
    return fullyObservedDayKeys;
  }
  return fullyObservedDayKeys.slice(-count);
}

export type ProductFeedObservationWindow = {
  trackingEpochStartedAt: string | null;
  firstFullObservedDay: string | null;
  fullDaysObserved: number;
  fullDaysRequired: number;
  fullyObservedDayKeys: string[];
  last7FullDayKeys: string[];
  observationStatus: "NO_TRACKING_DATA" | "INSUFFICIENT_FULL_DAYS" | "READY";
};

export function buildProductFeedObservationWindow(input: {
  trackingEpochStartedAt: Date | null;
  todayKey: string;
}): ProductFeedObservationWindow {
  const fullDaysRequired = PRODUCT_FEED_DONE_CONSECUTIVE_FULL_DAYS;
  if (input.trackingEpochStartedAt == null) {
    return {
      trackingEpochStartedAt: null,
      firstFullObservedDay: null,
      fullDaysObserved: 0,
      fullDaysRequired,
      fullyObservedDayKeys: [],
      last7FullDayKeys: [],
      observationStatus: "NO_TRACKING_DATA",
    };
  }

  const firstFullObservedDay = resolveFirstFullObservedDayKey(
    input.trackingEpochStartedAt
  );
  const fullyObservedDayKeys = listFullyObservedUtcDayKeysBeforeToday({
    firstFullObservedDayKey: firstFullObservedDay,
    todayKey: input.todayKey,
  });
  const fullDaysObserved = fullyObservedDayKeys.length;
  const last7FullDayKeys = selectLastFullyObservedDaysForStability(
    fullyObservedDayKeys
  );
  const observationStatus =
    fullDaysObserved < fullDaysRequired
      ? "INSUFFICIENT_FULL_DAYS"
      : "READY";

  return {
    trackingEpochStartedAt: input.trackingEpochStartedAt.toISOString(),
    firstFullObservedDay,
    fullDaysObserved,
    fullDaysRequired,
    fullyObservedDayKeys,
    last7FullDayKeys,
    observationStatus,
  };
}

export type ProductFeedDayRollup = {
  dayKey: string;
  /** Distinct trades evaluated (at-trade-time decisions). */
  tradeCandidates: number;
  /** Distinct trades with stake + EV thresholds met. */
  stakeEvQualified: number;
  /** @deprecated use stakeEvQualified */
  tradeLevelPassTrades: number;
  finalEligibleTrades: number;
  uniqueEligibleWallets: number;
  eligibleStakeUsd: number;
  rejectedByWalletGate: number;
  /** @deprecated use rejectedByWalletGate */
  walletGateRejectedTrades: number;
  rejectionBreakdown: Partial<
    Record<ProductFeedWalletBlockReason | "other", number>
  >;
  withinTargetRange: boolean;
};

export type PersistedProductFeedEligibilityDecision = {
  tradeId: string;
  tradedAt: Date;
  productFeedGateVersion: string;
  tradeStakePass: boolean;
  tradeEvPass: boolean;
  walletGatePass: boolean;
  finalEligible: boolean;
  blockReason: string | null;
  stakeUsd: number;
  walletAddress: string | null;
};

function isWalletRejectionBlockReason(
  reason: string | null
): reason is ProductFeedWalletBlockReason | "other" {
  return reason != null && WALLET_BLOCK_REASONS.has(reason);
}

/**
 * Roll up persisted at-trade-time rows into per-UTC-day funnel metrics.
 * One decision per trade_id per gate version — duplicates in input are ignored.
 */
export function aggregateProductFeedEligibilityByUtcDay(
  rows: PersistedProductFeedEligibilityDecision[],
  dayKeys: string[]
): ProductFeedDayRollup[] {
  const keySet = new Set(dayKeys);
  const byDay = new Map<string, Map<string, PersistedProductFeedEligibilityDecision>>();

  for (const key of dayKeys) {
    byDay.set(key, new Map());
  }

  for (const row of rows) {
    if (row.productFeedGateVersion !== PRODUCT_FEED_GATE_VERSION) continue;
    const dayKey = tradeDayKeyUtc(row.tradedAt);
    const bucket = byDay.get(dayKey);
    if (!bucket || !keySet.has(dayKey)) continue;
    bucket.set(row.tradeId, row);
  }

  return dayKeys.map((dayKey) => {
    const decisions = [...(byDay.get(dayKey)?.values() ?? [])];
    const eligibleWallets = new Set<string>();
    let stakeEvQualified = 0;
    let finalEligibleTrades = 0;
    let eligibleStakeUsd = 0;
    let rejectedByWalletGate = 0;
    const rejectionBreakdown: ProductFeedDayRollup["rejectionBreakdown"] = {};

    for (const row of decisions) {
      const stakeEvPass = row.tradeStakePass && row.tradeEvPass;
      if (stakeEvPass) stakeEvQualified += 1;
      if (row.finalEligible) {
        finalEligibleTrades += 1;
        eligibleStakeUsd += row.stakeUsd;
        if (row.walletAddress) eligibleWallets.add(row.walletAddress);
      } else if (stakeEvPass && !row.walletGatePass) {
        rejectedByWalletGate += 1;
        const reason = isWalletRejectionBlockReason(row.blockReason)
          ? row.blockReason
          : "other";
        rejectionBreakdown[reason] = (rejectionBreakdown[reason] ?? 0) + 1;
      }
    }

    return {
      dayKey,
      tradeCandidates: decisions.length,
      stakeEvQualified,
      tradeLevelPassTrades: stakeEvQualified,
      finalEligibleTrades,
      uniqueEligibleWallets: eligibleWallets.size,
      eligibleStakeUsd: Math.round(eligibleStakeUsd * 100) / 100,
      rejectedByWalletGate,
      walletGateRejectedTrades: rejectedByWalletGate,
      rejectionBreakdown,
      withinTargetRange: isWithinProductFeedDoneTargetRange(finalEligibleTrades),
    };
  });
}

export function buildProductFeedSevenDaySummary(input: {
  last7FullDays: ProductFeedDayRollup[];
  consecutiveTargetDaysRequired?: number;
  observationStatus?: ProductFeedObservationWindow["observationStatus"];
}): {
  fullDaysObserved: number;
  totalEligibleTrades: number;
  avgEligibleTradesPerDay: number;
  minEligibleTradesPerDay: number;
  maxEligibleTradesPerDay: number;
  daysWithinTargetRange: number;
  consecutiveDaysWithinTargetRange: number;
  doneCriteriaMet: boolean;
  observationStatus: ProductFeedObservationWindow["observationStatus"];
} {
  const days = input.last7FullDays;
  const required =
    input.consecutiveTargetDaysRequired ?? PRODUCT_FEED_DONE_CONSECUTIVE_FULL_DAYS;
  const observationStatus =
    input.observationStatus ??
    (days.length < required ? "INSUFFICIENT_FULL_DAYS" : "READY");
  const eligibleCounts = days.map((d) => d.finalEligibleTrades);
  const total = eligibleCounts.reduce((s, n) => s + n, 0);
  const within = days.filter((d) => d.withinTargetRange).length;

  let longestStreak = 0;
  let streak = 0;
  for (const day of days) {
    if (day.withinTargetRange) {
      streak += 1;
      longestStreak = Math.max(longestStreak, streak);
    } else {
      streak = 0;
    }
  }

  const doneCriteriaMet =
    observationStatus === "READY" &&
    days.length >= required &&
    longestStreak >= required;

  return {
    fullDaysObserved: days.length,
    totalEligibleTrades: total,
    avgEligibleTradesPerDay: days.length > 0 ? total / days.length : 0,
    minEligibleTradesPerDay:
      eligibleCounts.length > 0 ? Math.min(...eligibleCounts) : 0,
    maxEligibleTradesPerDay:
      eligibleCounts.length > 0 ? Math.max(...eligibleCounts) : 0,
    daysWithinTargetRange: within,
    consecutiveDaysWithinTargetRange: longestStreak,
    doneCriteriaMet,
    observationStatus,
  };
}

export function formatProductFeedSevenDayStabilityBlock(input: {
  last7FullDays: ProductFeedDayRollup[];
  sevenDaySummary: ReturnType<typeof buildProductFeedSevenDaySummary>;
}): string {
  const lines = ["PRODUCT_FEED_7_DAY_STABILITY", ""];
  for (const day of input.last7FullDays) {
    lines.push(`${day.dayKey}: ${day.finalEligibleTrades} eligible`);
  }
  const s = input.sevenDaySummary;
  if (input.last7FullDays.length === 0) {
    lines.push("(no fully observed days in tracking epoch yet)");
  }
  lines.push(
    "",
    `Observation status: ${s.observationStatus}`,
    `Average: ${s.avgEligibleTradesPerDay.toFixed(1)}/day`,
    `Min: ${s.minEligibleTradesPerDay}`,
    `Max: ${s.maxEligibleTradesPerDay}`,
    `Days in target: ${s.daysWithinTargetRange}/${s.fullDaysObserved}`,
    `Longest consecutive target streak: ${s.consecutiveDaysWithinTargetRange}`,
    "",
    `DONE_CRITERIA_MET: ${s.doneCriteriaMet ? "YES" : "NO"}`
  );
  return lines.join("\n");
}
