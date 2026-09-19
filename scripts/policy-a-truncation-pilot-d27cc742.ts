#!/usr/bin/env tsx
/**
 * Read-only Policy A truncation pilot for d27cc742 — corrected adaptive fromBlock.
 * No persistence, no cohort hydration.
 */
import "../tests/preload-env";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/crossmarket/store/db";
import {
  walletHistoricalMetrics,
  walletHistoryCoverage,
} from "@/lib/crossmarket/store/schema";
import { evaluateHistoricalPerformanceVerdict } from "@/lib/walletLedger/indexed/historicalPerformanceVerdict";
import { WALLET_METRIC_VERSION } from "@/lib/walletLedger/indexed/metricVersion";
import { runIndexedWalletAudit } from "@/lib/walletLedger/indexed/pipeline";
import {
  computeSourceBoundaryStats,
  resolveSourceSpecificTruncationFlags,
} from "@/lib/walletLedger/indexed/indexedCredibility";
import { summarizeCanonicalOrderDiagnostics } from "@/lib/walletLedger/eventOrder";
import { POLYMARKET_EXCHANGE_INITIAL_BLOCK } from "@/lib/walletLedger/onchain/contracts";
import { fetchActivityHistory, fetchTradeHistory } from "@/lib/walletLedger/fetchers";
import { extractApiSourceTimestamps } from "@/lib/walletLedger/onchain/startBlock";
import type { PositionLifecycle, WalletLedgerEvent } from "@/lib/walletLedger/types";

const WALLET = "0xd27cc742d023d06ef633a4c880cf1ff1836ec081";

const VERIFIED_SEP2023_TXS = [
  {
    txHash: "0xa7797ef2f04324b8b349dd01b2724196bdf8fdcc1a81e6ff67817a4c702ddab3",
    block: 47_546_811,
  },
  {
    txHash: "0x673a2c847d3d5a149eb1ef2cd4c75f02e70601235ed75ce2670d9b3a074f741a",
    block: 47_652_262,
  },
  {
    txHash: "0xbe3234d187d737c4a39e3b80c01fe1f007d3e23d54ba9a38cd44a9b1e3fd08f5",
    block: 47_652_288,
  },
] as const;

/** Previous pilot run (forceFromBlock=48,555,033) — for comparison only. */
const PREVIOUS_PILOT = {
  fromBlock: 48_555_033,
  indexedEventCount: 44_751,
  earliestIndexedBlock: null as number | null,
  earliestIndexedTimestamp: 1_716_117_635,
  completedPositions: 343,
  realizedRoi: 0.18817089728772826,
  profitablePositionRate: 0.8558823529411764,
  activityTruncationImmune: true,
  tradesTruncationImmune: true,
  historyValidity: "partial-but-metrics-safe",
  credibilityMetricsValid: true,
  policyAVerdict: "PASS",
};

function iso(ts: number | null | undefined): string | null {
  if (ts == null || !Number.isFinite(ts)) return null;
  return new Date(ts * 1000).toISOString();
}

function minBlock(events: WalletLedgerEvent[]): number | null {
  const blocks = events
    .map((event) => event.blockNumber ?? 0)
    .filter((block) => block > 0);
  return blocks.length > 0 ? Math.min(...blocks) : null;
}

function minTimestamp(events: WalletLedgerEvent[]): number | null {
  const timestamps = events
    .map((event) => event.timestamp)
    .filter((ts) => Number.isFinite(ts) && ts > 0);
  return timestamps.length > 0 ? Math.min(...timestamps) : null;
}

function summarizePilot(
  audit: Awaited<ReturnType<typeof runIndexedWalletAudit>>,
  sourceTs: ReturnType<typeof extractApiSourceTimestamps>,
  activityTruncated: boolean,
  tradesTruncated: boolean
) {
  const events = audit.authoritativeIndexedEvents ?? [];
  const metrics = audit.indexedLedgerMetrics;
  const boundaries = computeSourceBoundaryStats(
    events,
    sourceTs.oldestActivityTimestamp,
    sourceTs.oldestTradesTimestamp
  );
  const truncationFlags = resolveSourceSpecificTruncationFlags({
    apiActivityTruncated: activityTruncated,
    apiTradesTruncated: tradesTruncated,
    oldestActivityTimestamp: sourceTs.oldestActivityTimestamp,
    oldestTradesTimestamp: sourceTs.oldestTradesTimestamp,
    runSourceBoundaries: boundaries,
  });
  const verdict = evaluateHistoricalPerformanceVerdict({
    indexedDataValidity: Boolean(metrics?.credibilityMetricsValid),
    historyValidity: metrics?.historyValidity,
    historyComplete: metrics?.historyComplete,
    completedPositionCount: metrics?.completedPositionCount ?? null,
    realizedRoi: metrics?.portfolioRealizedRoi ?? null,
    profitablePositionRate: metrics?.profitablePositionRate ?? null,
    metricVersion: WALLET_METRIC_VERSION,
  });

  const pre57M = events.filter(
    (event) => (event.blockNumber ?? 0) < POLYMARKET_EXCHANGE_INITIAL_BLOCK
  );

  return {
    adaptiveFromBlock: audit.adaptiveFromBlock,
    fromBlock: audit.scanFromBlock,
    authoritativeIndexedEventCount: events.length,
    pre57MNormalizedEventCount: pre57M.length,
    pre57MWithTimestampGt0: pre57M.filter((event) => event.timestamp > 0).length,
    earliestIndexedBlock: minBlock(events),
    earliestResolvedIndexedTimestamp: minTimestamp(events),
    earliestResolvedIndexedIso: iso(minTimestamp(events)),
    eventsBeforeActivityBoundary: boundaries.eventsBeforeActivityBoundary,
    activityTruncationImmune: truncationFlags.activityTruncationImmune,
    tradesTruncationImmune: truncationFlags.tradesTruncationImmune,
    completedPositions: audit.indexedCompletedPositions,
    realizedRoi: metrics?.portfolioRealizedRoi,
    profitablePositionRate: metrics?.profitablePositionRate,
    historyValidity: metrics?.historyValidity,
    credibilityMetricsValid: metrics?.credibilityMetricsValid,
    reasons: metrics?.historyCompletenessReasons,
    policyAVerdict: verdict.historicalPerformanceDecision,
    mergeDiagnostics: audit.authoritativeEventStats,
    canonicalOrderDiagnostics: summarizeCanonicalOrderDiagnostics(events),
    lifecycleEpisodeCount: (audit.indexedLifecyclePositions ?? []).length,
    blockTimestampStats: audit.blockTimestampStats,
    deltaIndexedEventCount: audit.indexedEvents?.length ?? 0,
  };
}

async function verifyTxInclusion(
  events: WalletLedgerEvent[],
  positions: PositionLifecycle[]
) {
  return VERIFIED_SEP2023_TXS.map((target) => {
    const matched = events.filter(
      (event) => event.txHash?.toLowerCase() === target.txHash.toLowerCase()
    );
    const lifecycleTouches = positions.filter((position) =>
      position.events.some(
        (event) => event.txHash?.toLowerCase() === target.txHash.toLowerCase()
      )
    );
    const completedLifecycleTouches = lifecycleTouches.filter(
      (position) => position.completed
    );
    return {
      txHash: target.txHash,
      expectedBlock: target.block,
      presentInLedger: matched.length > 0,
      ledgerEvents: matched.map((event) => ({
        conditionId: event.conditionId,
        asset: event.asset,
        type: event.type,
        timestamp: event.timestamp,
        timestampIso: iso(event.timestamp),
        blockNumber: event.blockNumber,
        shares: event.shares,
        cashUsd: event.cashUsd,
      })),
      lifecycleCount: lifecycleTouches.length,
      completedLifecycleCount: completedLifecycleTouches.length,
      changesCompletedLifecycle: completedLifecycleTouches.length > 0,
    };
  });
}

function analyzePre57MTimestamps(events: WalletLedgerEvent[]) {
  const pre57M = events.filter(
    (event) => (event.blockNumber ?? 0) < POLYMARKET_EXCHANGE_INITIAL_BLOCK
  );
  const withResolvedTimestamp = pre57M.filter((event) => event.timestamp > 0);
  const withoutResolvedTimestamp = pre57M.filter(
    (event) => !event.timestamp || event.timestamp <= 0
  );
  const deltaPre57M = events.filter(
    (event) =>
      (event.blockNumber ?? 0) < POLYMARKET_EXCHANGE_INITIAL_BLOCK &&
      event.source === "polygon"
  );

  return {
    pre57MNormalizedLedgerEventCount: pre57M.length,
    pre57MWithResolvedBlockTimestamp: withResolvedTimestamp.length,
    pre57MWithoutResolvedBlockTimestamp: withoutResolvedTimestamp.length,
    earliestPre57MLedgerEventTimestamp: minTimestamp(pre57M),
    earliestPre57MLedgerEventTimestampIso: iso(minTimestamp(pre57M)),
    earliestPre57MBlock: minBlock(pre57M),
    earliestPre57MBlockWithResolvedTimestamp: minBlock(withResolvedTimestamp),
    sampleUnresolvedPre57MBlocks: [
      ...new Set(
        withoutResolvedTimestamp
          .map((event) => event.blockNumber)
          .filter((block): block is number => block != null && block > 0)
      ),
    ]
      .sort((a, b) => a - b)
      .slice(0, 10),
    explanation:
      pre57M.length > 0 && withResolvedTimestamp.length === 0
        ? "pre_57m_events_exist_but_block_timestamps_unresolved"
        : pre57M.length === 0
          ? "no_pre_57m_normalized_ledger_events_in_authoritative_set"
          : "pre_57m_events_present_with_partial_or_full_timestamp_resolution",
    deltaPolygonPre57MEventCount: deltaPre57M.length,
  };
}

async function loadPersistedBefore() {
  const db = getDb();
  const [metrics] = await db
    .select()
    .from(walletHistoricalMetrics)
    .where(
      and(
        eq(walletHistoricalMetrics.walletAddress, WALLET),
        eq(walletHistoricalMetrics.metricVersion, WALLET_METRIC_VERSION)
      )
    )
    .limit(1);
  const [coverage] = await db
    .select()
    .from(walletHistoryCoverage)
    .where(eq(walletHistoryCoverage.walletAddress, WALLET))
    .limit(1);
  return {
    fromBlock: POLYMARKET_EXCHANGE_INITIAL_BLOCK,
    indexedEventCount: coverage?.indexedEventCount ?? null,
    earliestIndexedBlock: null,
    earliestResolvedIndexedTimestamp: coverage?.indexedOldestTimestamp ?? null,
    completedPositions: metrics?.completedPositions ?? null,
    realizedRoi: metrics?.portfolioRealizedRoi ?? null,
    profitablePositionRate: metrics?.profitablePositionRate ?? null,
    activityTruncationImmune: false,
    tradesTruncationImmune: false,
    historyValidity: metrics?.historyValidity ?? null,
    credibilityMetricsValid: metrics?.credibilityMetricsValid ?? null,
    reasons: metrics?.historyIncompleteReasons ?? null,
    policyAVerdict: "FAIL",
  };
}

async function main() {
  const [activity, trades] = await Promise.all([
    fetchActivityHistory(WALLET),
    fetchTradeHistory(WALLET),
  ]);
  const sourceTs = extractApiSourceTimestamps(activity.rows, trades.rows);
  const persistedBefore = await loadPersistedBefore();

  const audit = await runIndexedWalletAudit({
    label: "policy-a-truncation-pilot-d27cc742-corrected",
    wallet: WALLET,
    providerId: "etherscan_v2",
    fullHistory: true,
    resumeCheckpoint: false,
    allowEarlierThanIncremental: true,
  });

  const correctedPilot = summarizePilot(
    audit,
    sourceTs,
    activity.truncated,
    trades.truncated
  );
  const events = audit.authoritativeIndexedEvents ?? [];
  const txInclusion = await verifyTxInclusion(
    events,
    audit.indexedLifecyclePositions ?? []
  );
  const timestampAnalysis = analyzePre57MTimestamps(events);

  const allVerifiedPresent = txInclusion.every((row) => row.presentInLedger);
  const allVerifiedHaveTimestamps = txInclusion.every(
    (row) =>
      row.presentInLedger &&
      row.ledgerEvents.every((event) => (event.timestamp ?? 0) > 0)
  );
  const fromBlockCorrect =
    correctedPilot.fromBlock != null &&
    correctedPilot.fromBlock < VERIFIED_SEP2023_TXS[0].block;
  const metricsStable =
    correctedPilot.completedPositions != null &&
    PREVIOUS_PILOT.completedPositions != null &&
    Math.abs(
      correctedPilot.completedPositions - PREVIOUS_PILOT.completedPositions
    ) <= 5;
  const roiStable =
    correctedPilot.realizedRoi != null &&
    Math.abs(correctedPilot.realizedRoi - PREVIOUS_PILOT.realizedRoi) < 0.02;
  const validityOk =
    correctedPilot.historyValidity === "partial-but-metrics-safe" &&
    correctedPilot.credibilityMetricsValid === true;
  const policyPass = correctedPilot.policyAVerdict === "PASS";
  const activityImmune = correctedPilot.activityTruncationImmune === true;
  const earliestReachesSep2023 =
    (correctedPilot.earliestResolvedIndexedTimestamp ?? Number.MAX_SAFE_INTEGER) <
    1_700_000_000;
  const mergeStats = audit.authoritativeEventStats;
  const noMaterialLedgerConflicts =
    (mergeStats?.ledgerFieldConflicts ?? 0) === 0;

  let recommendation: "SAFE_TO_PERSIST_D27C" | "FIX_REQUIRED" = "FIX_REQUIRED";
  if (
    fromBlockCorrect &&
    allVerifiedPresent &&
    allVerifiedHaveTimestamps &&
    earliestReachesSep2023 &&
    validityOk &&
    policyPass &&
    activityImmune &&
    metricsStable &&
    roiStable &&
    noMaterialLedgerConflicts
  ) {
    recommendation = "SAFE_TO_PERSIST_D27C";
  }

  const timestampPatchReady =
    "patchPersistedEventTimestamps updates wallet_ledger_events rows by blockNumber where block_timestamp IS NULL using authoritative merged timestamps";

  console.log(
    JSON.stringify(
      {
        mode: "policy_a_truncation_pilot_d27cc742_corrected",
        wallet: WALLET,
        comparison: {
          persistedBefore,
          previousPilot: PREVIOUS_PILOT,
          correctedPilot,
        },
        verifiedSep2023TxInclusion: txInclusion,
        pre57MTimestampAnalysis: timestampAnalysis,
        sep2023TradeVerification: audit.verifiedTradeTxEvidence,
        mergeDiagnostics: mergeStats,
        persistedTimestampPatchPath: timestampPatchReady,
        recommendation,
        recommendationChecks: {
          fromBlockEarlierThanVerifiedTrade: fromBlockCorrect,
          allVerifiedTxsPresentInLedger: allVerifiedPresent,
          allVerifiedTxsHaveResolvedTimestamps: allVerifiedHaveTimestamps,
          earliestResolvedTimestampReachesSep2023: earliestReachesSep2023,
          metricsStableVsPreviousPilot: metricsStable,
          roiStableVsPreviousPilot: roiStable,
          validityPartialButMetricsSafe: validityOk,
          policyAPass: policyPass,
          activityTruncationImmune: activityImmune,
          noMaterialLedgerFieldConflicts: noMaterialLedgerConflicts,
        },
      },
      null,
      2
    )
  );
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
