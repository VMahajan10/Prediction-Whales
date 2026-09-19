#!/usr/bin/env tsx
/**
 * Policy A small-batch pilot — 4 representative wallets.
 * Full index → persist → pipeline-aligned validation.
 */
import "../tests/preload-env";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/crossmarket/store/db";
import {
  walletHistoricalMetrics,
  walletHistoryCoverage,
} from "@/lib/crossmarket/store/schema";
import { sortLedgerEventsCanonical, summarizeCanonicalOrderDiagnostics } from "@/lib/walletLedger/eventOrder";
import {
  fetchActivityHistory,
  fetchTradeHistory,
} from "@/lib/walletLedger/fetchers";
import { GammaResolutionCache, buildMarketResolveHints } from "@/lib/walletLedger/gamma";
import {
  POLYMARKET_EXCHANGE_INITIAL_BLOCK,
} from "@/lib/walletLedger/onchain/contracts";
import { extractApiSourceTimestamps } from "@/lib/walletLedger/onchain/startBlock";
import { mergeApiAndChainEvents } from "@/lib/walletLedger/onchain/normalize";
import { buildPositionLifecycles } from "@/lib/walletLedger/ledger";
import { analyzeMergeSplitImpact } from "@/lib/walletLedger/mergeSplitAnalysis";
import { computeWalletLedgerMetrics } from "@/lib/walletLedger/metrics";
import {
  deduplicateLedgerEvents,
  normalizeActivityRows,
  normalizeTradeRows,
} from "@/lib/walletLedger/normalize";
import {
  verifiedOldestBlockFromEvidence,
} from "@/lib/walletLedger/indexed/adaptiveStartBlock";
import { evaluateHistoricalPerformanceVerdict } from "@/lib/walletLedger/indexed/historicalPerformanceVerdict";
import { readPersistentGammaCache } from "@/lib/walletLedger/indexed/gammaCacheStore";
import { WALLET_METRIC_VERSION } from "@/lib/walletLedger/indexed/metricVersion";
import { runIndexedWalletAudit } from "@/lib/walletLedger/indexed/pipeline";
import { countPersistedEventMetadataCoverage } from "@/lib/walletLedger/indexed/store/eventMetadataEnrichment";
import {
  loadPersistedCoverageSnapshot,
  loadPersistedWalletEvents,
  persistIndexedWalletAudit,
} from "@/lib/walletLedger/indexed/store/persistWalletHistory";

const PILOT_WALLETS = [
  {
    wallet: "0x4f29e103339919c4baaea2a60195cf1c8bb27a7e",
    role: "source_specific_semantics_only",
    expectSourceImmunityWithoutEarlierScan: true,
  },
  {
    wallet: "0xe9076a87c5ed90ef16e6fe6529c943baeca0cff6",
    role: "adaptive_earlier_chain_indexing",
    expectVerifiedEvidenceForEarlierScan: true,
  },
  {
    wallet: "0x1ff3d3fdef2558f3eb4aabdd7011a0245df8eb39",
    role: "metrics_safe_regression_control",
    expectRemainPass: true,
    expectCompletedApprox: 147,
  },
  {
    wallet: "0xde7be6d489bce070a959e0cb813128ae659b5f4b",
    role: "additional_truncation_case",
  },
] as const;

type PilotWallet = (typeof PILOT_WALLETS)[number];

interface WalletSnapshot {
  completedPositions: number | null;
  realizedRoi: number | null;
  profitablePositionRate: number | null;
  historyValidity: string | null;
  credibilityMetricsValid: boolean | null;
  policyAVerdict: string;
  validityReasons: string[];
  activityTruncated: boolean;
  tradesTruncated: boolean;
  oldestActivityTimestamp: number | null;
  oldestTradesTimestamp: number | null;
  indexedOldestTimestamp: number | null;
  fromBlock: number | null;
}

interface StopCondition {
  code: string;
  detail: string;
}

function iso(ts: number | null | undefined): string | null {
  if (ts == null || !Number.isFinite(ts)) return null;
  return new Date(ts * 1000).toISOString();
}

function policyFromMetrics(input: {
  credibilityMetricsValid: boolean | null | undefined;
  historyValidity: string | null | undefined;
  completedPositions: number | null | undefined;
  realizedRoi: number | null | undefined;
  profitablePositionRate: number | null | undefined;
}): string {
  return evaluateHistoricalPerformanceVerdict({
    indexedDataValidity: Boolean(input.credibilityMetricsValid),
    historyValidity: input.historyValidity,
    completedPositionCount: input.completedPositions ?? null,
    realizedRoi: input.realizedRoi ?? null,
    profitablePositionRate: input.profitablePositionRate ?? null,
    metricVersion: WALLET_METRIC_VERSION,
  }).historicalPerformanceDecision;
}

async function loadBeforeSnapshot(wallet: string): Promise<WalletSnapshot> {
  const db = getDb();
  const normalized = wallet.toLowerCase();
  const [metrics] = await db
    .select()
    .from(walletHistoricalMetrics)
    .where(
      and(
        eq(walletHistoricalMetrics.walletAddress, normalized),
        eq(walletHistoricalMetrics.metricVersion, WALLET_METRIC_VERSION)
      )
    )
    .limit(1);
  const [coverage] = await db
    .select()
    .from(walletHistoryCoverage)
    .where(eq(walletHistoryCoverage.walletAddress, normalized))
    .limit(1);

  const reasons = metrics?.historyIncompleteReasons ?? [];
  return {
    completedPositions: metrics?.completedPositions ?? null,
    realizedRoi: metrics?.realizedRoi ?? null,
    profitablePositionRate: metrics?.profitablePositionRate ?? null,
    historyValidity: metrics?.historyValidity ?? null,
    credibilityMetricsValid: metrics?.credibilityMetricsValid ?? null,
    policyAVerdict: policyFromMetrics({
      credibilityMetricsValid: metrics?.credibilityMetricsValid,
      historyValidity: metrics?.historyValidity,
      completedPositions: metrics?.completedPositions,
      realizedRoi: metrics?.realizedRoi,
      profitablePositionRate: metrics?.profitablePositionRate,
    }),
    validityReasons: reasons,
    activityTruncated: reasons.includes("activity_truncated"),
    tradesTruncated: reasons.includes("trades_truncated"),
    oldestActivityTimestamp: null,
    oldestTradesTimestamp: null,
    indexedOldestTimestamp: coverage?.indexedOldestTimestamp ?? null,
    fromBlock: coverage?.fromBlock ?? null,
  };
}

async function fetchApiBoundaries(wallet: string) {
  const [activity, trades] = await Promise.all([
    fetchActivityHistory(wallet, { interPageDelayMs: 25 }),
    fetchTradeHistory(wallet, { interPageDelayMs: 25 }),
  ]);
  const sourceTs = extractApiSourceTimestamps(activity.rows, trades.rows);
  return {
    activity,
    trades,
    sourceTs,
    activityTruncated: activity.truncated,
    tradesTruncated: trades.truncated,
  };
}

function snapshotFromAudit(
  audit: Awaited<ReturnType<typeof runIndexedWalletAudit>>
): WalletSnapshot {
  const metrics = audit.indexedLedgerMetrics;
  const immunity = audit.sourceTruncationImmunity;
  const reasons = audit.indexedCredibility?.reasons ?? [];
  return {
    completedPositions: metrics?.completedPositionCount ?? null,
    realizedRoi: metrics?.portfolioRealizedRoi ?? null,
    profitablePositionRate: metrics?.profitablePositionRate ?? null,
    historyValidity: metrics?.historyValidity ?? null,
    credibilityMetricsValid: metrics?.credibilityMetricsValid ?? null,
    policyAVerdict: policyFromMetrics({
      credibilityMetricsValid: metrics?.credibilityMetricsValid,
      historyValidity: metrics?.historyValidity,
      completedPositions: metrics?.completedPositionCount,
      realizedRoi: metrics?.portfolioRealizedRoi,
      profitablePositionRate: metrics?.profitablePositionRate,
    }),
    validityReasons: reasons,
    activityTruncated: immunity?.activityTruncated ?? false,
    tradesTruncated: immunity?.tradesTruncated ?? false,
    oldestActivityTimestamp: audit.coverage.oldestActivityTimestamp,
    oldestTradesTimestamp: audit.coverage.oldestTradesTimestamp,
    indexedOldestTimestamp: audit.coverage.indexedOldestTimestamp,
    fromBlock: audit.scanFromBlock ?? null,
  };
}

function checkMergeStopConditions(
  audit: Awaited<ReturnType<typeof runIndexedWalletAudit>>
): StopCondition[] {
  const stops: StopCondition[] = [];
  const stats = audit.authoritativeEventStats;

  if ((stats?.ledgerFieldConflicts ?? 0) > 0) {
    stops.push({
      code: "ledger_field_conflict",
      detail: `ledgerFieldConflicts=${stats?.ledgerFieldConflicts}`,
    });
  }
  if ((stats?.timestampConflicts ?? 0) > 0) {
    stops.push({
      code: "metadata_conflict",
      detail: `timestampConflicts=${stats?.timestampConflicts}`,
    });
  }

  const adaptive = audit.adaptiveFromBlock;
  const verifiedBlock = verifiedOldestBlockFromEvidence(
    audit.verifiedTradeTxEvidence ?? []
  );
  if (
    (audit.scanFromBlock ?? POLYMARKET_EXCHANGE_INITIAL_BLOCK) <
      POLYMARKET_EXCHANGE_INITIAL_BLOCK &&
    adaptive?.contributingSource === "exchange_initial_block_fallback"
  ) {
    stops.push({
      code: "unverified_adaptive_from_block",
      detail: `fromBlock=${audit.scanFromBlock} without verified evidence`,
    });
  }
  if (
    (audit.scanFromBlock ?? POLYMARKET_EXCHANGE_INITIAL_BLOCK) <
      POLYMARKET_EXCHANGE_INITIAL_BLOCK &&
    verifiedBlock == null &&
    adaptive?.verifiedRelevantChainEventBlock == null &&
    adaptive?.pilotProvenEarliestBlock == null
  ) {
    stops.push({
      code: "unverified_adaptive_from_block",
      detail: `fromBlock=${audit.scanFromBlock} below 57M with no verified trade/chain/pilot evidence`,
    });
  }

  return stops;
}

async function loadPersistedLogIndexGap(wallet: string) {
  const coverage = await countPersistedEventMetadataCoverage(wallet);
  const polygonWithBlock = coverage.withBlock;
  const polygonMissingLogIndex = Math.max(
    0,
    polygonWithBlock - coverage.withLogIndex
  );
  return {
    coverage,
    polygonWithBlock,
    polygonMissingLogIndex,
    missingLogIndexPct:
      polygonWithBlock > 0 ? polygonMissingLogIndex / polygonWithBlock : 0,
  };
}

async function checkPostPersistCanonicalCoverage(
  metadataConflicts: number
): Promise<StopCondition[]> {
  const stops: StopCondition[] = [];
  if (metadataConflicts > 0) {
    stops.push({
      code: "metadata_conflict",
      detail: `metadataConflicts=${metadataConflicts}`,
    });
  }
  return stops;
}

function checkValidationStopConditions(input: {
  metadataConflicts: number;
  persistedCompleted: number | null;
  validationCompleted: number | null;
  persistedPolicyA: string;
  validationPolicyA: string;
}): StopCondition[] {
  const stops: StopCondition[] = [];

  if (
    input.persistedCompleted != null &&
    input.validationCompleted != null &&
    input.persistedCompleted > 0
  ) {
    const drift =
      Math.abs(input.validationCompleted - input.persistedCompleted) /
      input.persistedCompleted;
    if (drift > 0.05) {
      stops.push({
        code: "completed_position_drift",
        detail: `persist=${input.persistedCompleted} validation=${input.validationCompleted} drift=${(drift * 100).toFixed(2)}%`,
      });
    }
  }

  if (input.persistedPolicyA !== input.validationPolicyA) {
    stops.push({
      code: "policy_a_mismatch",
      detail: `persist=${input.persistedPolicyA} validation=${input.validationPolicyA}`,
    });
  }

  return stops;
}

async function pipelineAlignedValidation(
  wallet: string,
  activityTruncated: boolean,
  tradesTruncated: boolean
) {
  const persisted = sortLedgerEventsCanonical(await loadPersistedWalletEvents(wallet));
  const [activity, trades] = await Promise.all([
    fetchActivityHistory(wallet, { interPageDelayMs: 25 }),
    fetchTradeHistory(wallet, { interPageDelayMs: 25 }),
  ]);
  const apiEvents = deduplicateLedgerEvents(
    normalizeActivityRows(activity.rows, wallet),
    normalizeTradeRows(trades.rows, wallet)
  );
  const combined = mergeApiAndChainEvents(apiEvents, persisted);
  const gammaCache = new GammaResolutionCache();
  gammaCache.seedMany(readPersistentGammaCache().entries());
  await gammaCache.prefetch(buildMarketResolveHints(combined));
  const { positions } = await buildPositionLifecycles(wallet, combined, gammaCache);
  const mergeSplit = analyzeMergeSplitImpact(positions);
  const metrics = computeWalletLedgerMetrics({
    positions,
    identity: {
      confidence: "high",
      resolutionMethod: "proxy_wallet_direct",
      positionsOnlyMismatch: false,
    },
    activityTruncated,
    tradesTruncated,
    rawEventCount: combined.length,
    deduplicatedEventCount: combined.length,
    gammaCoverage: {
      distinctMarkets: new Set(positions.map((p) => p.conditionId).filter(Boolean)).size,
      marketsFoundBefore: 1,
      marketsFoundAfter: 1,
      resolvedBefore: 0,
      resolvedAfter: 0,
      coverageBeforePct: 1,
      coverageAfterPct: 1,
      marketFoundCoverageAfterPct: 1,
    },
    mergeSplit,
    hasHistoryEvents: combined.length > 0,
  });
  const policyAVerdict = policyFromMetrics({
    credibilityMetricsValid: metrics.credibilityMetricsValid,
    historyValidity: metrics.historyValidity,
    completedPositions: metrics.completedPositionCount,
    realizedRoi: metrics.portfolioRealizedRoi,
    profitablePositionRate: metrics.profitablePositionRate,
  });
  return {
    apiEvents,
    combined,
    positions,
    metrics,
    policyAVerdict,
    orderDiagnostics: summarizeCanonicalOrderDiagnostics(combined),
  };
}

function countApiOnlyInCombined(
  apiEvents: Awaited<ReturnType<typeof deduplicateLedgerEvents>>,
  authoritative: Awaited<ReturnType<typeof runIndexedWalletAudit>>["authoritativeIndexedEvents"]
) {
  const authKeys = new Set((authoritative ?? []).map((e) => e.dedupeKey));
  return apiEvents.filter((e) => !authKeys.has(e.dedupeKey)).length;
}

function behavedAsExpected(
  pilot: PilotWallet,
  before: WalletSnapshot,
  after: WalletSnapshot,
  hydration: {
    earlierScanNeeded: boolean;
    sourceImmunityWorked: boolean;
    verifiedLoweredFromBlock: boolean;
  }
): boolean {
  if (pilot.role === "source_specific_semantics_only") {
    return (
      hydration.sourceImmunityWorked &&
      !hydration.earlierScanNeeded &&
      after.credibilityMetricsValid === true
    );
  }
  if (pilot.role === "adaptive_earlier_chain_indexing") {
    if (hydration.verifiedLoweredFromBlock) {
      return after.indexedOldestTimestamp != null;
    }
    return before.indexedOldestTimestamp == null;
  }
  if (pilot.role === "metrics_safe_regression_control") {
    const completedOk =
      pilot.expectCompletedApprox == null ||
      after.completedPositions == null ||
      Math.abs((after.completedPositions ?? 0) - pilot.expectCompletedApprox) <= 5;
    return after.policyAVerdict === "PASS" && completedOk;
  }
  if (pilot.role === "additional_truncation_case") {
    return hydration.sourceImmunityWorked || after.credibilityMetricsValid === true;
  }
  return true;
}

async function processWallet(pilot: PilotWallet) {
  const started = Date.now();
  const wallet = pilot.wallet.toLowerCase();

  console.error(`\n[pilot] === ${pilot.role} ${wallet} ===`);

  const before = await loadBeforeSnapshot(wallet);
  const apiBoundaries = await fetchApiBoundaries(wallet);
  before.oldestActivityTimestamp = apiBoundaries.sourceTs.oldestActivityTimestamp;
  before.oldestTradesTimestamp = apiBoundaries.sourceTs.oldestTradesTimestamp;

  const coverageBefore = await loadPersistedCoverageSnapshot(wallet);

  console.error(`[pilot] BEFORE ${wallet}`, JSON.stringify({
    ...before,
    oldestActivityIso: iso(before.oldestActivityTimestamp),
    oldestTradesIso: iso(before.oldestTradesTimestamp),
    indexedOldestIso: iso(before.indexedOldestTimestamp),
  }));

  const audit = await runIndexedWalletAudit({
    label: `policy-a-small-batch-${pilot.role}`,
    wallet,
    providerId: "etherscan_v2",
    fullHistory: true,
    resumeCheckpoint: true,
    allowEarlierThanIncremental: true,
  });

  const authoritative = audit.authoritativeIndexedEvents ?? [];
  const mergeStats = audit.authoritativeEventStats;
  const adaptive = audit.adaptiveFromBlock;
  const immunity = audit.sourceTruncationImmunity;
  const verifiedBlock = verifiedOldestBlockFromEvidence(
    audit.verifiedTradeTxEvidence ?? []
  );

  const apiEvents = deduplicateLedgerEvents(
    normalizeActivityRows(apiBoundaries.activity.rows, wallet),
    normalizeTradeRows(apiBoundaries.trades.rows, wallet)
  );
  const combined = mergeApiAndChainEvents(apiEvents, authoritative);
  const apiOnlyCount = countApiOnlyInCombined(apiEvents, authoritative);
  const authDiag = summarizeCanonicalOrderDiagnostics(authoritative);
  const eventsWithBlock = authoritative.filter((e) => (e.blockNumber ?? 0) > 0).length;
  const eventsWithLogIndex = authoritative.filter(
    (e) => e.logIndex != null && e.logIndex >= 0
  ).length;

  const previousFromBlock =
    before.fromBlock ?? coverageBefore?.lastIndexedBlock ?? POLYMARKET_EXCHANGE_INITIAL_BLOCK;
  const earlierScanNeeded =
    (audit.scanFromBlock ?? POLYMARKET_EXCHANGE_INITIAL_BLOCK) < previousFromBlock;

  const verifiedLoweredFromBlock =
    earlierScanNeeded &&
    (audit.scanFromBlock ?? POLYMARKET_EXCHANGE_INITIAL_BLOCK) <
      POLYMARKET_EXCHANGE_INITIAL_BLOCK &&
    (verifiedBlock != null ||
      adaptive?.contributingSource === "verified_chain_event" ||
      adaptive?.contributingSource === "verified_trade" ||
      adaptive?.contributingSource === "pilot_proven");

  const hydration = {
    selectedFromBlock: audit.scanFromBlock,
    adaptiveReason: adaptive?.reason ?? audit.coverage.adaptiveFromBlockReason,
    contributingSource: adaptive?.contributingSource,
    verifiedOldestTradeBlock: adaptive?.verifiedOldestTradeBlock ?? verifiedBlock,
    verifiedRelevantChainEventBlock: adaptive?.verifiedRelevantChainEventBlock,
    verifiedLoweredFromBlock,
    authoritativeEventCount: authoritative.length,
    apiEventCount: apiEvents.length,
    combinedEventCount: combined.length,
    apiOnlyInCombined: apiOnlyCount,
    eventsWithBlockNumber: eventsWithBlock,
    eventsWithLogIndex,
    mergeDuplicateEventsMerged: mergeStats?.duplicateEventsMerged ?? 0,
    timestampUpgrades: mergeStats?.timestampUpgrades ?? 0,
    timestampConflicts: mergeStats?.timestampConflicts ?? 0,
    ledgerFieldConflicts: mergeStats?.ledgerFieldConflicts ?? 0,
    lifecycleEpisodeCount: audit.indexedLifecyclePositions?.length ?? 0,
    earlierScanNeeded,
    sourceImmunityWorked: Boolean(
      immunity?.activityTruncationImmune || immunity?.tradesTruncationImmune
    ),
  };

  console.error(`[pilot] HYDRATION ${wallet}`, JSON.stringify(hydration, null, 2));

  const truncationValidity = {
    eventsBeforeActivityBoundary: audit.coverage.eventsBeforeActivityBoundary,
    activityTruncationImmune: immunity?.activityTruncationImmune ?? false,
    eventsBeforeTradesBoundary: audit.coverage.eventsBeforeTradesBoundary,
    tradesTruncationImmune: immunity?.tradesTruncationImmune ?? false,
    apiActivityTruncated: apiBoundaries.activityTruncated,
    apiTradesTruncated: apiBoundaries.tradesTruncated,
    finalActivityTruncated: immunity?.activityTruncated ?? false,
    finalTradesTruncated: immunity?.tradesTruncated ?? false,
    finalValidityReasons: audit.indexedCredibility?.reasons ?? [],
  };

  console.error(`[pilot] TRUNCATION ${wallet}`, JSON.stringify(truncationValidity, null, 2));

  const prePersistStops = checkMergeStopConditions(audit);

  if (prePersistStops.length > 0) {
    return {
      pilot,
      wallet,
      stopped: true,
      stopConditions: prePersistStops,
      before,
      after: null,
      hydration,
      truncationValidity,
      validation: null,
      elapsedMs: Date.now() - started,
    };
  }

  const persistResult = await persistIndexedWalletAudit(audit);
  const after = snapshotFromAudit(audit);

  console.error(`[pilot] AFTER ${wallet}`, JSON.stringify({
    ...after,
    persist: {
      eventsUpserted: persistResult.eventsUpserted,
      metadataEnrichment: persistResult.metadataEnrichment,
    },
  }));

  const logIndexGap = await loadPersistedLogIndexGap(wallet);
  const postPersistStops = await checkPostPersistCanonicalCoverage(
    persistResult.metadataEnrichment.metadataConflicts
  );

  if (postPersistStops.length > 0) {
    return {
      pilot,
      wallet,
      stopped: true,
      stopConditions: postPersistStops,
      before,
      after,
      hydration,
      truncationValidity,
      validation: null,
      elapsedMs: Date.now() - started,
    };
  }

  const validation = await pipelineAlignedValidation(
    wallet,
    immunity?.activityTruncated ?? false,
    immunity?.tradesTruncated ?? false
  );

  const validationStops = checkValidationStopConditions({
    metadataConflicts: persistResult.metadataEnrichment.metadataConflicts,
    persistedCompleted: after.completedPositions,
    validationCompleted: validation.metrics.completedPositionCount,
    persistedPolicyA: after.policyAVerdict,
    validationPolicyA: validation.policyAVerdict,
  });

  const pipelineValidationMatched = validationStops.length === 0;

  console.error(`[pilot] VALIDATION ${wallet}`, JSON.stringify({
    completedPositions: validation.metrics.completedPositionCount,
    realizedRoi: validation.metrics.portfolioRealizedRoi,
    profitablePositionRate: validation.metrics.profitablePositionRate,
    policyAVerdict: validation.policyAVerdict,
    lifecycleEpisodes: validation.positions.length,
    combinedEvents: validation.combined.length,
    deltaCompleted:
      (validation.metrics.completedPositionCount ?? 0) -
      (after.completedPositions ?? 0),
    deltaRoi:
      (validation.metrics.portfolioRealizedRoi ?? 0) - (after.realizedRoi ?? 0),
    deltaProfitableRate:
      (validation.metrics.profitablePositionRate ?? 0) -
      (after.profitablePositionRate ?? 0),
    pipelineValidationMatched,
  }));

  return {
    pilot,
    wallet,
    stopped: !pipelineValidationMatched,
    stopConditions: validationStops,
    before,
    after,
    hydration,
    truncationValidity,
    validation: {
      completedPositions: validation.metrics.completedPositionCount,
      realizedRoi: validation.metrics.portfolioRealizedRoi,
      profitablePositionRate: validation.metrics.profitablePositionRate,
      policyAVerdict: validation.policyAVerdict,
      lifecycleEpisodes: validation.positions.length,
      deltaCompleted:
        (validation.metrics.completedPositionCount ?? 0) -
        (after.completedPositions ?? 0),
      deltaRoi:
        (validation.metrics.portfolioRealizedRoi ?? 0) - (after.realizedRoi ?? 0),
      deltaProfitableRate:
        (validation.metrics.profitablePositionRate ?? 0) -
        (after.profitablePositionRate ?? 0),
      pipelineValidationMatched,
      metadataEnrichment: persistResult.metadataEnrichment,
      persistedMetadataCoverage: logIndexGap.coverage,
      logIndexGap,
    },
    elapsedMs: Date.now() - started,
    behavedAsExpected: behavedAsExpected(pilot, before, after, hydration),
  };
}

async function main() {
  const skipWallets = new Set(
    (process.env.SKIP_WALLETS ?? "")
      .split(",")
      .map((wallet) => wallet.trim().toLowerCase())
      .filter(Boolean)
  );
  const results: Awaited<ReturnType<typeof processWallet>>[] = [];

  for (const pilot of PILOT_WALLETS) {
    if (skipWallets.has(pilot.wallet.toLowerCase())) {
      console.error(`[pilot] skipping ${pilot.wallet} (SKIP_WALLETS)`);
      continue;
    }
    const result = await processWallet(pilot);
    results.push(result);
    if (result.stopped) {
      console.error(
        `[pilot] STOP batch — ${result.wallet}: ${result.stopConditions.map((s) => s.code).join(", ")}`
      );
      break;
    }
  }

  const table = results.map((r) => ({
    wallet: r.wallet,
    role: r.pilot.role,
    beforeValidity: r.before.historyValidity,
    afterValidity: r.after?.historyValidity ?? null,
    beforeCompleted: r.before.completedPositions,
    afterCompleted: r.after?.completedPositions ?? null,
    beforePolicyA: r.before.policyAVerdict,
    afterPolicyA: r.after?.policyAVerdict ?? null,
    earlierScanNeeded: r.hydration.earlierScanNeeded,
    sourceSpecificImmunityWorked: r.hydration.sourceImmunityWorked,
    pipelineValidationMatched: r.validation?.pipelineValidationMatched ?? false,
    elapsedSeconds: Math.round(r.elapsedMs / 1000),
    stopped: r.stopped,
  }));

  const processedAll = results.length === PILOT_WALLETS.length && results.every((r) => !r.stopped);
  const expectedCount = results.filter((r) => r.behavedAsExpected).length;
  const anyStopped = results.some((r) => r.stopped);

  const recommendation = processedAll && !anyStopped
    ? "READY_FOR_BOUNDED_COHORT_HYDRATION"
    : "FIX_REQUIRED";

  const summary = {
    mode: "policy_a_small_batch_pilot",
    walletsProcessed: results.length,
    walletsTotal: PILOT_WALLETS.length,
    stoppedEarly: anyStopped,
    stopDetails: results.flatMap((r) =>
      r.stopConditions.map((s) => ({ wallet: r.wallet, ...s }))
    ),
    table,
    behavedAsExpectedCount: expectedCount,
    behavedAsExpectedTotal: results.length,
    systemicIssues: anyStopped
      ? results
          .filter((r) => r.stopped)
          .map((r) => r.stopConditions.map((s) => `${r.wallet}:${s.code}`).join(", "))
      : [],
    truncationGeneralizedBeyondD27c: results.some(
      (r) =>
        r.hydration.sourceImmunityWorked ||
        r.hydration.verifiedLoweredFromBlock
    ),
    logIndexGaps: results
      .map((r) => ({
        wallet: r.wallet,
        ...(r.validation?.logIndexGap ?? {}),
      }))
      .filter((row) => row.polygonWithBlock != null),
    recommendation,
    walletDetails: results,
  };

  console.log(JSON.stringify(summary, null, 2));
  if (recommendation === "FIX_REQUIRED") {
    process.exit(1);
  }
}

void main().catch((error) => {
  console.error("[policy-a-small-batch-pilot] failed:", error);
  process.exit(1);
});
