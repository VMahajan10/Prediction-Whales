#!/usr/bin/env tsx
/**
 * Read-only Product Feed Option 1 daily / 7-day stability report.
 *
 * Official done criterion uses at-trade-time rows in feed_trade_eligibility
 * (no silent replay fallback).
 */
import "../tests/preload-env";
import pg from "pg";
import {
  aggregateProductFeedEligibilityByUtcDay,
  buildProductFeedObservationWindow,
  buildProductFeedSevenDaySummary,
  formatProductFeedSevenDayStabilityBlock,
  PRODUCT_FEED_ELIGIBLE_DAY_BOUNDARY,
  PRODUCT_FEED_GATE_VERSION,
  type PersistedProductFeedEligibilityDecision,
} from "@/lib/feed/productFeedEligibleDailyReport";
import { feedMetricsDayKeyUtc } from "@/lib/feedMetricsCore";

async function feedTradeEligibilityTableExists(
  client: pg.PoolClient
): Promise<boolean> {
  const result = await client.query<{ exists: boolean }>(
    `
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = 'feed_trade_eligibility'
    ) AS exists
    `
  );
  return result.rows[0]?.exists === true;
}

async function loadTrackingEpochStartedAt(
  client: pg.PoolClient
): Promise<Date | null> {
  const result = await client.query<{ min_evaluated_at: Date | null }>(
    `
    SELECT MIN(evaluated_at) AS min_evaluated_at
    FROM feed_trade_eligibility
    WHERE product_feed_gate_version = $1
    `,
    [PRODUCT_FEED_GATE_VERSION]
  );
  const value = result.rows[0]?.min_evaluated_at;
  return value ?? null;
}

async function loadAtTradeTimeDecisions(
  client: pg.PoolClient,
  since: Date,
  until: Date
): Promise<PersistedProductFeedEligibilityDecision[]> {
  const result = await client.query<{
    trade_id: string;
    traded_at: Date;
    product_feed_gate_version: string;
    trade_stake_pass: boolean;
    trade_ev_pass: boolean;
    wallet_gate_pass: boolean;
    final_eligible: boolean;
    block_reason: string | null;
    stake_usd: number;
    wallet_address: string | null;
  }>(
    `
    SELECT trade_id, traded_at, product_feed_gate_version,
           trade_stake_pass, trade_ev_pass, wallet_gate_pass,
           final_eligible, block_reason, stake_usd, wallet_address
    FROM feed_trade_eligibility
    WHERE product_feed_gate_version = $1
      AND traded_at >= $2
      AND traded_at < $3
    `,
    [PRODUCT_FEED_GATE_VERSION, since, until]
  );

  return result.rows.map((row) => ({
    tradeId: row.trade_id,
    tradedAt: row.traded_at,
    productFeedGateVersion: row.product_feed_gate_version,
    tradeStakePass: row.trade_stake_pass,
    tradeEvPass: row.trade_ev_pass,
    walletGatePass: row.wallet_gate_pass,
    finalEligible: row.final_eligible,
    blockReason: row.block_reason,
    stakeUsd: row.stake_usd,
    walletAddress: row.wallet_address,
  }));
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL not configured");
    process.exit(1);
  }

  const todayKey = feedMetricsDayKeyUtc();
  const pool = new pg.Pool({ connectionString: url });
  const client = await pool.connect();

  try {
    const tableReady = await feedTradeEligibilityTableExists(client);
    let decisions: PersistedProductFeedEligibilityDecision[] = [];
    let atTradeTimeDataStatus: "available" | "table_missing" | "empty" =
      "table_missing";
    let trackingEpochStartedAt: Date | null = null;

    if (tableReady) {
      trackingEpochStartedAt = await loadTrackingEpochStartedAt(client);
      atTradeTimeDataStatus =
        trackingEpochStartedAt != null ? "available" : "empty";
    }

    const observationWindow = buildProductFeedObservationWindow({
      trackingEpochStartedAt,
      todayKey,
    });

    const rollupDayKeys = [...observationWindow.last7FullDayKeys, todayKey];
    const since =
      trackingEpochStartedAt ??
      new Date(`${todayKey}T00:00:00.000Z`);
    const until = new Date(`${todayKey}T23:59:59.999Z`);

    if (tableReady && trackingEpochStartedAt != null) {
      decisions = await loadAtTradeTimeDecisions(client, since, until);
    }

    const rollups = aggregateProductFeedEligibilityByUtcDay(
      decisions,
      rollupDayKeys
    );
    const rollupByDay = new Map(rollups.map((r) => [r.dayKey, r]));

    const emptyRollup = (dayKey: string) => ({
      dayKey,
      tradeCandidates: 0,
      stakeEvQualified: 0,
      tradeLevelPassTrades: 0,
      finalEligibleTrades: 0,
      uniqueEligibleWallets: 0,
      eligibleStakeUsd: 0,
      rejectedByWalletGate: 0,
      walletGateRejectedTrades: 0,
      rejectionBreakdown: {},
      withinTargetRange: false,
    });

    const last7FullDays = observationWindow.last7FullDayKeys.map(
      (key) => rollupByDay.get(key) ?? emptyRollup(key)
    );
    const todayRollup = rollupByDay.get(todayKey) ?? emptyRollup(todayKey);

    const sevenDaySummary = buildProductFeedSevenDaySummary({
      last7FullDays,
      observationStatus: observationWindow.observationStatus,
    });

    const report = {
      generatedAt: new Date().toISOString(),
      sourceOfTruth: "at-trade-time" as const,
      atTradeTimeDataStatus,
      dayBoundary: PRODUCT_FEED_ELIGIBLE_DAY_BOUNDARY,
      productFeedGateVersion: PRODUCT_FEED_GATE_VERSION,
      trackingEpochStartedAt: observationWindow.trackingEpochStartedAt,
      firstFullObservedDay: observationWindow.firstFullObservedDay,
      fullDaysObserved: observationWindow.fullDaysObserved,
      fullDaysRequired: observationWindow.fullDaysRequired,
      observationStatus: observationWindow.observationStatus,
      interpretation: {
        eligibleTrades:
          "COUNT DISTINCT trade_id where final_eligible = true, grouped by UTC calendar day of traded_at.",
        fullyObservedDay:
          "UTC calendar day that begins at or after trackingEpochStartedAt's first full day (epoch partial day excluded).",
        partialCurrentUtcDay:
          "Included in today funnel only; excluded from 7-day done criterion.",
        preInstrumentationDays:
          "Never included as zero-eligible observed days before trackingEpochStartedAt.",
        replayFallback:
          "Not used for DONE_CRITERIA_MET when sourceOfTruth is at-trade-time.",
        unavailable:
          atTradeTimeDataStatus === "table_missing"
            ? "feed_trade_eligibility table not present — apply migration 0030 before tracking."
            : atTradeTimeDataStatus === "empty"
              ? "No persisted decisions for gate version — deploy instrumentation and wait for production evaluations."
              : null,
      },
      today: {
        dayKey: todayKey,
        partialDay: true,
        ...todayRollup,
      },
      last7FullDays,
      sevenDaySummary,
      stabilityBlock: formatProductFeedSevenDayStabilityBlock({
        last7FullDays,
        sevenDaySummary,
      }),
    };

    console.log(JSON.stringify(report, null, 2));
    console.error("\n" + report.stabilityBlock + "\n");
  } finally {
    client.release();
    await pool.end();
  }
}

void main().catch((error) => {
  console.error("[product-feed-eligible-daily-report]", error);
  process.exit(1);
});
