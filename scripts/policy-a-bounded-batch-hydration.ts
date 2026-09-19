#!/usr/bin/env tsx
/**
 * Policy A bounded cohort hydration — serial batch with exact replay gate.
 */
import "../tests/preload-env";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb, isDatabaseEnabled } from "@/lib/crossmarket/store/db";
import {
  policyAProductionWalletHydration,
  walletHistoricalMetrics,
  walletHistoryCoverage,
} from "@/lib/crossmarket/store/schema";
import {
  verifiedOldestBlockFromEvidence,
} from "@/lib/walletLedger/indexed/adaptiveStartBlock";
import { evaluateHistoricalPerformanceVerdict } from "@/lib/walletLedger/indexed/historicalPerformanceVerdict";
import { WALLET_METRIC_VERSION } from "@/lib/walletLedger/indexed/metricVersion";
import { runIndexedWalletAudit } from "@/lib/walletLedger/indexed/pipeline";
import { POLYMARKET_EXCHANGE_INITIAL_BLOCK } from "@/lib/walletLedger/onchain/contracts";
import {
  buildProductionWalletCohort,
  type ProductionWalletCohortMember,
} from "@/lib/walletLedger/indexed/shadow/productionWalletCohort";
import {
  assessBatchHydrationEligibility,
  computeHydrationGate,
  loadBatchHydrationEligibilityContext,
  summarizeCohortCoverage,
} from "@/lib/walletLedger/indexed/shadow/productionWalletHydration";
import { assessClassDRecoveryQueueStatus } from "@/lib/walletLedger/indexed/store/durableValidityRefresh";
import { assessUnresolvedChainOrder } from "@/lib/walletLedger/indexed/store/unresolvedChainOrder";
import {
  filterChainAuthoritativeEvents,
  hashAuthoritativeEventIdentities,
} from "@/lib/walletLedger/indexed/store/authoritativePersistence";
import { buildLogIndexTaxonomyReport } from "@/lib/walletLedger/indexed/store/logIndexTaxonomy";
import {
  loadPersistedWalletEvents,
  markDerivedStateCommitted,
  markDerivedStateUncommitted,
  persistAuthoritativePhase,
  persistDerivedPhase,
} from "@/lib/walletLedger/indexed/store/persistWalletHistory";
import {
  buildLifecycleInput,
  buildValidationSnapshotFromAudit,
  compareReplayToSnapshot,
  hashLifecycleInput,
  lifecycleEpisodeKey,
  prepareAuthoritativeEventsForLifecycleMerge,
  replayMetricsFromValidationSnapshot,
  saveValidationSnapshot,
} from "@/lib/walletLedger/indexed/store/validationSnapshot";
import { classifyChainEventIdentity } from "@/lib/walletLedger/canonicalChainIdentity";

const MAX_WALLETS = Number(process.env.MAX_WALLETS ?? "8");
const BATCH_NUMBER = Number(process.env.BATCH_NUMBER ?? "3");
const MAX_CONCURRENCY = Number(process.env.MAX_CONCURRENCY ?? "2");
const DRY_RUN = process.env.DRY_RUN === "1";
const SKIP_WALLETS = new Set(
  (process.env.SKIP_WALLETS ?? "")
    .split(",")
    .map((wallet) => wallet.trim().toLowerCase())
    .filter(Boolean)
);
const ONLY_WALLETS = (process.env.ONLY_WALLETS ?? "")
  .split(",")
  .map((wallet) => wallet.trim().toLowerCase())
  .filter(Boolean);

const BATCH1_WALLETS = [
  "0x0562e01b3c3e65bb93bf0de32f02cec238a79d66",
  "0x1610db79f753a80207e1d66716be9e91e627ae49",
  "0x18f0faf72b241dc55094ae704987e391c2a23d5e",
  "0x5268527977f700f9bf9b6d5cd843859e4e70135d",
  "0xfe787d2da716d60e8acff57fb87eb13cd4d10319",
  "0x25db6ca5935ae858a5c1f2dcd5c62939805328de",
  "0x0346afae2603313d2bbee96b628536c8cbe352a5",
  "0x165136c0307328458726cd65681d3513b610470f",
];

/** Batch-2 wallets that completed hydration successfully (exclude from Batch 3). */
const BATCH2_SUCCESS_WALLETS = [
  "0x30e443872ddf63b2908a49f92cd690c304a55102",
  "0x34f9a6c6ceed499b4f95dcceb2856d22b2a30540",
  "0x4be7b8b87d47b5f71b0e44a24d9645b2b58b1115",
  "0x709e3ea86a900aa3fb7a998d06e20d6ce68d027d",
  "0x718cc547c1ae200d1367a66d2d7b7ea614fdb4c2",
];

/** Class-D recovery queue — not eligible for normal hydration. */
const CLASS_D_RECOVERY_WALLETS = [
  "0x40b96182a35fbe3c2bb4162e036ecf0c786db002",
  "0x4e56f1ddaa8f5328036c449b89e731ec748cdee1",
  "0x2a69660046d7acc4ab204d7cc5ba78b0776cd2f7",
];

const BATCH3_STARTING_COHORT = {
  total: 77,
  pass: 11,
  fail: 29,
  unknown: 37,
  evaluablePct: 51.9,
  validDurableCoveragePct: 62.3,
};

const EXCLUDED_WALLETS = new Set([
  "0xd27cc742d023d06ef633a4c880cf1ff1836ec081",
  "0x4f29e103339919c4baaea2a60195cf1c8bb27a7e",
  "0xe9076a87c5ed90ef16e6fe6529c943baeca0cff6",
  "0x1ff3d3fdef2558f3eb4aabdd7011a0245df8eb39",
  "0xde7be6d489bce070a959e0cb813128ae659b5f4b",
  "0xd91e80cf2e7be2e162c6513ced06f1dd0da35296",
  "0x0000000000000000000000000000000000000000",
  ...BATCH1_WALLETS,
  ...BATCH2_SUCCESS_WALLETS,
  ...CLASS_D_RECOVERY_WALLETS,
]);

function isValidWalletAddress(wallet: string): boolean {
  return /^0x[0-9a-f]{40}$/.test(wallet) && !EXCLUDED_WALLETS.has(wallet);
}

type SelectionBucket =
  | "source_specific_semantics"
  | "earlier_index"
  | "no_indexed_history"
  | "production_relevant";

interface SelectedWallet {
  wallet: string;
  bucket: SelectionBucket;
  priorityTier: number;
  reason: string;
  hydrationEligibilityReason: string;
  hydrationStatus: string | null;
  hydrationUpdatedAt: string | null;
  member: ProductionWalletCohortMember;
  metricReasons: string[];
}

interface WalletPreState {
  feedVisibleTradeCount: number;
  passesProductionWalletGate: boolean;
  tradeGateQualifiedTradeCount: number;
  completedPositions: number | null;
  realizedRoi: number | null;
  profitablePositionRate: number | null;
  historyValidity: string | null;
  credibilityMetricsValid: boolean | null;
  policyAVerdict: string;
  validityReasons: string[];
  activityTruncated: boolean;
  tradesTruncated: boolean;
  indexedOldestTimestamp: number | null;
}

function policyVerdict(input: {
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

async function loadMetricReasons(wallet: string): Promise<string[]> {
  const db = getDb();
  const [row] = await db
    .select({ reasons: walletHistoricalMetrics.historyIncompleteReasons })
    .from(walletHistoricalMetrics)
    .where(
      and(
        eq(walletHistoricalMetrics.walletAddress, wallet.toLowerCase()),
        eq(walletHistoricalMetrics.metricVersion, WALLET_METRIC_VERSION)
      )
    )
    .limit(1);
  return row?.reasons ?? [];
}

async function loadPreState(
  member: ProductionWalletCohortMember,
  reasons: string[]
): Promise<WalletPreState> {
  const db = getDb();
  const wallet = member.wallet.toLowerCase();
  const [metrics] = await db
    .select()
    .from(walletHistoricalMetrics)
    .where(
      and(
        eq(walletHistoricalMetrics.walletAddress, wallet),
        eq(walletHistoricalMetrics.metricVersion, WALLET_METRIC_VERSION)
      )
    )
    .limit(1);
  const [coverage] = await db
    .select()
    .from(walletHistoryCoverage)
    .where(eq(walletHistoryCoverage.walletAddress, wallet))
    .limit(1);

  return {
    feedVisibleTradeCount: member.feedVisibleTradeCount,
    passesProductionWalletGate: member.passesProductionWalletGate,
    tradeGateQualifiedTradeCount: member.tradeGateQualifiedTradeCount,
    completedPositions: metrics?.completedPositions ?? null,
    realizedRoi: metrics?.realizedRoi ?? null,
    profitablePositionRate: metrics?.profitablePositionRate ?? null,
    historyValidity: metrics?.historyValidity ?? null,
    credibilityMetricsValid: metrics?.credibilityMetricsValid ?? null,
    policyAVerdict: member.policyADecision,
    validityReasons: reasons,
    activityTruncated: reasons.includes("activity_truncated"),
    tradesTruncated: reasons.includes("trades_truncated"),
    indexedOldestTimestamp: coverage?.indexedOldestTimestamp ?? null,
  };
}

function isTruncationBlocked(reasons: string[], member: ProductionWalletCohortMember): boolean {
  return (
    reasons.includes("activity_truncated") ||
    reasons.includes("trades_truncated") ||
    member.historyValidity === "partial-and-metrics-unsafe"
  );
}

function isEarlierIndexCandidate(
  member: ProductionWalletCohortMember,
  reasons: string[]
): boolean {
  if (isTruncationBlocked(reasons, member)) return false;
  return (
    member.policyAUnknownReason === "incomplete_indexed_history" ||
    reasons.includes("gamma_resolution_incomplete") ||
    reasons.includes("historical_backfill_required")
  );
}

function isNoIndexedHistory(member: ProductionWalletCohortMember): boolean {
  return (
    member.policyAUnknownReason === "no_indexed_history" ||
    member.policyAUnknownReason === "hydration_pending" ||
    member.policyAUnknownReason === "hydration_failed" ||
    member.policyAUnknownReason === "missing_metrics" ||
    (!member.hasIndexedMetrics && !member.hasIndexedCoverage)
  );
}

function pickOne(
  pool: SelectedWallet[],
  used: Set<string>
): SelectedWallet | null {
  const candidate = pool.find((row) => !used.has(row.wallet));
  if (!candidate) return null;
  used.add(candidate.wallet);
  return candidate;
}

async function buildSelectedWallet(
  member: ProductionWalletCohortMember,
  eligibilityContext: Awaited<
    ReturnType<typeof loadBatchHydrationEligibilityContext>
  >
): Promise<SelectedWallet | null> {
  const reasons = eligibilityContext.metricReasons;
  const eligibility = assessBatchHydrationEligibility({
    member,
    metricReasons: reasons,
    hydrationStatus: eligibilityContext.hydrationStatus,
    coverage: eligibilityContext.coverage,
  });
  if (!eligibility.eligible) {
    return null;
  }

  let bucket: SelectionBucket = "production_relevant";
  let reason = `tier=${member.priorityTier} unknown=${member.policyAUnknownReason ?? "none"}`;
  if (isTruncationBlocked(reasons, member)) {
    bucket = "source_specific_semantics";
    reason = `truncation-blocked activity=${reasons.includes("activity_truncated")} trades=${reasons.includes("trades_truncated")}`;
  } else if (isEarlierIndexCandidate(member, reasons)) {
    bucket = "earlier_index";
    reason = `earlier-index candidate reason=${member.policyAUnknownReason}`;
  } else if (isNoIndexedHistory(member)) {
    bucket = "no_indexed_history";
    reason = `no/pending indexed history reason=${member.policyAUnknownReason}`;
  } else if (member.feedVisibleTradeCount > 0) {
    reason = `feed-visible=${member.feedVisibleTradeCount}`;
  } else if (member.passesProductionWalletGate) {
    reason = "production-wallet-gate";
  } else if (member.tradeGateQualifiedTradeCount > 0) {
    reason = `trade-gate-qualified=${member.tradeGateQualifiedTradeCount}`;
  }
  return {
    wallet: member.wallet.toLowerCase(),
    bucket,
    priorityTier: member.priorityTier,
    reason,
    hydrationEligibilityReason: eligibility.hydrationEligibilityReason,
    hydrationStatus: eligibilityContext.hydrationStatus,
    hydrationUpdatedAt: eligibilityContext.hydrationUpdatedAt?.toISOString() ?? null,
    member,
    metricReasons: reasons,
  };
}

async function selectExplicitWallets(
  cohort: Awaited<ReturnType<typeof buildProductionWalletCohort>>,
  wallets: string[]
): Promise<SelectedWallet[]> {
  const selected: SelectedWallet[] = [];
  for (const wallet of wallets) {
    const member = cohort.wallets.find(
      (row) => row.wallet.toLowerCase() === wallet.toLowerCase()
    );
    if (!member) {
      throw new Error(`ONLY_WALLETS member not found in cohort: ${wallet}`);
    }
    if (!isValidWalletAddress(member.wallet)) {
      throw new Error(`ONLY_WALLETS member excluded or invalid: ${wallet}`);
    }
    const eligibilityContext = await loadBatchHydrationEligibilityContext(
      member.wallet
    );
    const row = await buildSelectedWallet(member, eligibilityContext);
    if (!row) {
      throw new Error(
        `ONLY_WALLETS member not hydration-eligible: ${wallet}`
      );
    }
    selected.push(row);
  }
  return selected;
}

function selectionPriority(row: SelectedWallet): number {
  const m = row.member;
  if (m.feedVisibleTradeCount > 0) return 1;
  if (m.passesProductionWalletGate) return 2;
  if (m.tradeGateQualifiedTradeCount > 0) return 3;
  if (m.policyAUnknownReason === "incomplete_indexed_history") return 4;
  if (m.policyAUnknownReason === "hydration_pending") return 5;
  if (
    m.policyAUnknownReason === "no_indexed_history" ||
    m.policyAUnknownReason === "missing_metrics"
  ) {
    return 6;
  }
  if (m.policyAUnknownReason === "hydration_failed") return 7;
  if (m.policyAUnknownReason === "invalid_indexed_history") return 8;
  return 9;
}

async function selectBatch(
  cohort: Awaited<ReturnType<typeof buildProductionWalletCohort>>
): Promise<SelectedWallet[]> {
  const eligible: SelectedWallet[] = [];
  for (const member of cohort.wallets) {
    if (!isValidWalletAddress(member.wallet)) continue;
    if (SKIP_WALLETS.has(member.wallet.toLowerCase())) continue;
    if (member.policyADecision !== "UNKNOWN") continue;
    const eligibilityContext = await loadBatchHydrationEligibilityContext(
      member.wallet
    );
    const row = await buildSelectedWallet(member, eligibilityContext);
    if (row) eligible.push(row);
  }

  eligible.sort(
    (a, b) =>
      selectionPriority(a) - selectionPriority(b) ||
      a.priorityTier - b.priorityTier ||
      a.wallet.localeCompare(b.wallet)
  );

  return eligible.slice(0, MAX_WALLETS);
}

function hashApiEvents(events: { dedupeKey: string }[]): string {
  return createHash("sha256")
    .update(events.map((event) => event.dedupeKey).sort().join("\n"))
    .digest("hex");
}

function hashGamma(entries: Array<[string, unknown]>): string {
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

function isInfraError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /timeout|ETIMEDOUT|ECONNRESET|503|507|rate limit|circuit|NeonDbError/i.test(
    message
  );
}

interface HydrateWalletOptions {
  shouldAbortBeforePhase2?: () => boolean;
}

async function hydrateWallet(
  selected: SelectedWallet,
  options: HydrateWalletOptions = {}
) {
  const started = Date.now();
  const wallet = selected.wallet.toLowerCase();
  const eligibilityContext = await loadBatchHydrationEligibilityContext(wallet);
  const eligibility = assessBatchHydrationEligibility({
    member: selected.member,
    metricReasons: eligibilityContext.metricReasons,
    hydrationStatus: eligibilityContext.hydrationStatus,
    coverage: eligibilityContext.coverage,
  });
  if (!eligibility.eligible) {
    return {
      wallet,
      priorityReason: selected.reason,
      bucket: selected.bucket,
      finalStatus: "already_hydrated",
      stoppedBatch: false,
      stopReason: eligibility.hydrationEligibilityReason,
      before: await loadPreState(selected.member, selected.metricReasons),
      after: null,
      exactReplayPass: false,
      elapsedMs: Date.now() - started,
    };
  }

  const before = await loadPreState(selected.member, selected.metricReasons);

  let auditStarted = false;
  let persistCommitted = false;

  try {
    const audit = await runIndexedWalletAudit({
      label: `policy-a-batch${BATCH_NUMBER}-${wallet.slice(0, 8)}`,
      wallet,
      providerId: "etherscan_v2",
      fullHistory: true,
      resumeCheckpoint: true,
      allowEarlierThanIncremental: true,
    });
    auditStarted = true;
    const throughBlock = audit.throughBlock ?? null;

    const apiEvents = audit.apiEvents ?? [];
    if (apiEvents.length === 0) {
      throw new Error("audit.apiEvents missing");
    }

    const authoritative = filterChainAuthoritativeEvents(
      audit.authoritativeIndexedEvents ?? []
    );
    const adaptive = audit.adaptiveFromBlock;
    const verifiedBlock = verifiedOldestBlockFromEvidence(
      audit.verifiedTradeTxEvidence ?? []
    );
    const immunity = audit.sourceTruncationImmunity;
    const mergeStats = audit.authoritativeEventStats;
    const logIndexTaxonomy = buildLogIndexTaxonomyReport({
      authoritativeEvents: authoritative,
    });
    const lifecycleInput = hashLifecycleInput(
      buildLifecycleInput(apiEvents, authoritative)
    );
    let classD = 0;
    for (const event of authoritative) {
      if (classifyChainEventIdentity(event) === "unresolved_chain_log") {
        classD += 1;
      }
    }

    const systemicStops: string[] = [];
    if ((mergeStats?.ledgerFieldConflicts ?? 0) > 0) {
      systemicStops.push("economic_ledger_conflict");
    }
    if ((mergeStats?.timestampConflicts ?? 0) > 0) {
      systemicStops.push("metadata_conflict");
    }
    if (
      (audit.scanFromBlock ?? POLYMARKET_EXCHANGE_INITIAL_BLOCK) <
        POLYMARKET_EXCHANGE_INITIAL_BLOCK &&
      verifiedBlock == null &&
      adaptive?.verifiedRelevantChainEventBlock == null &&
      adaptive?.pilotProvenEarliestBlock == null &&
      adaptive?.contributingSource === "exchange_initial_block_fallback"
    ) {
      systemicStops.push("unverified_adaptive_from_block");
    }

    if (systemicStops.length > 0) {
      return {
        wallet,
        priorityReason: selected.reason,
        bucket: selected.bucket,
        finalStatus: "wallet_failed",
        stoppedBatch: true,
        stopReason: systemicStops.join(","),
        before,
        after: null,
        exactReplayPass: false,
        elapsedMs: Date.now() - started,
      };
    }

    const persistResult = await persistAuthoritativePhase(audit);
    persistCommitted = true;

    const persistDiag = persistResult.authoritativePersistDiagnostics;
    if (
      (persistDiag?.persistableMissingAfter ?? 0) > 0 ||
      persistDiag?.baselineComplete !== true
    ) {
      await markDerivedStateUncommitted(
        wallet,
        `baseline_incomplete persistableMissingAfter=${persistDiag?.persistableMissingAfter}`
      );
      return {
        wallet,
        priorityReason: selected.reason,
        bucket: selected.bucket,
        finalStatus: "wallet_failed",
        stoppedBatch: true,
        stopReason: `baseline_incomplete persistableMissingAfter=${persistDiag?.persistableMissingAfter}`,
        before,
        after: null,
        exactReplayPass: false,
        elapsedMs: Date.now() - started,
      };
    }
    if (persistResult.metadataEnrichment.metadataConflicts > 0) {
      return {
        wallet,
        priorityReason: selected.reason,
        bucket: selected.bucket,
        finalStatus: "wallet_failed",
        stoppedBatch: true,
        stopReason: "metadata_conflict",
        before,
        after: null,
        exactReplayPass: false,
        elapsedMs: Date.now() - started,
      };
    }

    const auditPreparedChain = prepareAuthoritativeEventsForLifecycleMerge(
      filterChainAuthoritativeEvents(audit.authoritativeIndexedEvents ?? [])
    );
    const persistedChain = prepareAuthoritativeEventsForLifecycleMerge(
      filterChainAuthoritativeEvents(await loadPersistedWalletEvents(wallet))
    );
    const persistedHash = hashAuthoritativeEventIdentities(persistedChain);
    const auditPreparedHash = hashAuthoritativeEventIdentities(auditPreparedChain);
    if (persistedHash !== auditPreparedHash) {
      return {
        wallet,
        priorityReason: selected.reason,
        bucket: selected.bucket,
        finalStatus: "wallet_failed",
        stoppedBatch: true,
        stopReason: "canonical_identity_persist_mismatch",
        before,
        after: null,
        exactReplayPass: false,
        elapsedMs: Date.now() - started,
      };
    }

    const snapshot = buildValidationSnapshotFromAudit(
      { ...audit, authoritativeIndexedEvents: persistedChain },
      { apiEvents, gammaCacheEntries: audit.gammaCacheEntries ?? [] }
    );
    const replayA = await replayMetricsFromValidationSnapshot(snapshot, {
      chainEventsOverride: persistedChain,
      frozen: true,
    });
    const frozenSnapshot = {
      ...snapshot,
      auditMetrics: replayA.metrics,
      lifecycleEpisodeKeys: replayA.positions.map(lifecycleEpisodeKey).sort(),
    };
    const replayB = await replayMetricsFromValidationSnapshot(frozenSnapshot, {
      chainEventsOverride: persistedChain,
      frozen: true,
    });
    const comparison = compareReplayToSnapshot(frozenSnapshot, replayB);
    const snapshotPath = await saveValidationSnapshot(frozenSnapshot);

    const committedMetrics = replayA.fullLedgerMetrics;
    const committedVerdict = policyVerdict({
      credibilityMetricsValid: committedMetrics?.credibilityMetricsValid,
      historyValidity: committedMetrics?.historyValidity,
      completedPositions: committedMetrics?.completedPositionCount,
      realizedRoi: committedMetrics?.portfolioRealizedRoi,
      profitablePositionRate: committedMetrics?.profitablePositionRate,
    });

    const exactReplayPass =
      !replayA.inputMismatch &&
      !replayB.inputMismatch &&
      comparison.exactMatch &&
      replayB.replayLifecycleInputSequenceHash ===
        replayA.replayLifecycleInputSequenceHash &&
      replayB.replayLifecycleInputEventCount ===
        replayA.replayLifecycleInputEventCount &&
      replayA.replayLifecycleInputSequenceHash ===
        (snapshot.auditLifecycleInputSequenceHash ??
          snapshot.auditLifecycleInputHash) &&
      replayA.replayLifecycleInputEventCount ===
        (snapshot.auditLifecycleInputEventCount ??
          snapshot.auditLifecycleInputCount);

    const unresolvedAssessment = assessUnresolvedChainOrder(persistedChain);
    const classDRecoveryStatus = assessClassDRecoveryQueueStatus({
      lifecycleRelevantUnresolved:
        unresolvedAssessment.unresolvedChainEventsInLifecycle,
      lifecycleClassDBefore: classD,
    });
    const hydrationGate = computeHydrationGate({
      coverage: eligibilityContext.coverage,
      hasValidationSnapshot: true,
    });

    if (!exactReplayPass) {
      await markDerivedStateUncommitted(
        wallet,
        replayA.inputMismatchReason ?? "exact_replay_failed"
      );
      return {
        wallet,
        priorityReason: selected.reason,
        bucket: selected.bucket,
        finalStatus: "wallet_failed",
        stoppedBatch: true,
        stopReason: replayA.inputMismatchReason ?? "exact_replay_failed",
        before,
        after: {
          policyAVerdict: committedVerdict,
          completedPositions: committedMetrics?.completedPositionCount ?? null,
          realizedRoi: committedMetrics?.portfolioRealizedRoi ?? null,
          profitablePositionRate: committedMetrics?.profitablePositionRate ?? null,
          historyValidity: committedMetrics?.historyValidity ?? null,
        },
        reconstruction: {
          throughBlock,
          scanFromBlock: audit.scanFromBlock,
          adaptiveReason: adaptive?.reason,
          authoritativeCount: persistedChain.length,
          authoritativeHash: persistedHash,
          classD,
          apiCount: apiEvents.length,
          apiHash: hashApiEvents(apiEvents),
          gammaCount: (audit.gammaCacheEntries ?? []).length,
          lifecycleInputHash: snapshot.auditLifecycleInputHash,
          replayLifecycleInputHash: replayA.replayLifecycleInputHash,
        },
        exactReplayPass: false,
        snapshotPath,
        elapsedMs: Date.now() - started,
      };
    }

    if (options.shouldAbortBeforePhase2?.()) {
      await markDerivedStateUncommitted(wallet, "batch_stop_before_phase2");
      return {
        wallet,
        priorityReason: selected.reason,
        bucket: selected.bucket,
        finalStatus: "wallet_failed",
        stoppedBatch: true,
        stopReason: "batch_stop_before_phase2",
        before,
        after: null,
        exactReplayPass: true,
        elapsedMs: Date.now() - started,
      };
    }

    const derivedResult = await persistDerivedPhase({
      ...audit,
      indexedLifecyclePositions: replayA.positions,
      indexedLedgerMetrics: committedMetrics,
    });
    await markDerivedStateCommitted(wallet);

    const db = getDb();
    await db
      .update(policyAProductionWalletHydration)
      .set({
        status: "complete",
        completedPositions: committedMetrics?.completedPositionCount ?? null,
        historyValidity: committedMetrics?.historyValidity ?? null,
        policyADecision: committedVerdict,
        lastError:
          classDRecoveryStatus === "not_needed"
            ? null
            : `classDRecoveryStatus=${classDRecoveryStatus}`,
        updatedAt: new Date(),
      })
      .where(eq(policyAProductionWalletHydration.walletAddress, wallet));

    const truncationCleared =
      (before.activityTruncated || before.tradesTruncated) &&
      !(immunity?.activityTruncated ?? false) &&
      !(immunity?.tradesTruncated ?? false);

    return {
      wallet,
      priorityReason: selected.reason,
      bucket: selected.bucket,
      finalStatus: "complete",
      stoppedBatch: false,
      before,
      after: {
        policyAVerdict: committedVerdict,
        completedPositions: committedMetrics?.completedPositionCount ?? null,
        realizedRoi: committedMetrics?.portfolioRealizedRoi ?? null,
        profitablePositionRate: committedMetrics?.profitablePositionRate ?? null,
        historyValidity: committedMetrics?.historyValidity ?? null,
        credibilityMetricsValid: committedMetrics?.credibilityMetricsValid ?? null,
      },
      phase2Committed: true,
      lifecycleParity: derivedResult.lifecycleStats.lifecycleParity,
      reconstruction: {
        throughBlock,
        scanFromBlock: audit.scanFromBlock,
        adaptiveReason: adaptive?.reason,
        contributingSource: adaptive?.contributingSource,
        verifiedOldestTradeBlock: adaptive?.verifiedOldestTradeBlock ?? verifiedBlock,
        authoritativeCount: persistedChain.length,
        authoritativeHash: persistedHash,
        classD,
        logIndexMissing: logIndexTaxonomy.missingLogIndex,
        apiCount: apiEvents.length,
        apiHash: hashApiEvents(apiEvents),
        gammaCount: (audit.gammaCacheEntries ?? []).length,
        gammaHash: hashGamma(audit.gammaCacheEntries ?? []),
        lifecycleInputCount: lifecycleInput.count,
        lifecycleInputHash: snapshot.auditLifecycleInputHash,
        eventsInserted: persistDiag?.authoritativeEventsInserted ?? 0,
        baselineComplete: persistDiag?.baselineComplete ?? false,
      },
      truncation: {
        activityTruncated: immunity?.activityTruncated ?? false,
        oldestActivityTimestamp: audit.coverage.oldestActivityTimestamp,
        eventsBeforeActivityBoundary: audit.coverage.eventsBeforeActivityBoundary,
        activityTruncationImmune: immunity?.activityTruncationImmune ?? false,
        tradesTruncated: immunity?.tradesTruncated ?? false,
        oldestTradesTimestamp: audit.coverage.oldestTradesTimestamp,
        eventsBeforeTradesBoundary: audit.coverage.eventsBeforeTradesBoundary,
        tradesTruncationImmune: immunity?.tradesTruncationImmune ?? false,
        validityReasons: audit.indexedCredibility?.reasons ?? [],
      },
      truncationCleared,
      hydrationGate,
      classDRecoveryStatus,
      unresolvedChainEventsInLifecycle:
        unresolvedAssessment.unresolvedChainEventsInLifecycle,
      staleLifecyclesDeleted:
        derivedResult.lifecycleStats.staleLifecycleRowsDeleted ?? 0,
      earlierScanRequired:
        (audit.scanFromBlock ?? POLYMARKET_EXCHANGE_INITIAL_BLOCK) <
        (before.indexedOldestTimestamp != null ? POLYMARKET_EXCHANGE_INITIAL_BLOCK : POLYMARKET_EXCHANGE_INITIAL_BLOCK),
      exactReplayPass: true,
      snapshotPath,
      elapsedMs: Date.now() - started,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isInfraError(error) && !persistCommitted) {
      return {
        wallet,
        priorityReason: selected.reason,
        bucket: selected.bucket,
        finalStatus: "deferred_infra",
        stoppedBatch: false,
        stopReason: message,
        before,
        after: null,
        exactReplayPass: false,
        elapsedMs: Date.now() - started,
      };
    }
    return {
      wallet,
      priorityReason: selected.reason,
      bucket: selected.bucket,
      finalStatus: auditStarted && !persistCommitted ? "wallet_failed" : "wallet_failed",
      stoppedBatch: true,
      stopReason: message,
      before,
      after: null,
      exactReplayPass: false,
      elapsedMs: Date.now() - started,
    };
  }
}

async function main() {
  if (!isDatabaseEnabled()) {
    console.error("DATABASE_URL not configured");
    process.exit(1);
  }

  const preCohort = await buildProductionWalletCohort();
  const preSummary = summarizeCohortCoverage(preCohort.wallets);
  const selected =
    ONLY_WALLETS.length > 0
      ? await selectExplicitWallets(preCohort, ONLY_WALLETS)
      : await selectBatch(preCohort);

  console.error(
    `[batch${BATCH_NUMBER}] SELECTED WALLETS:\n` +
      selected
        .map((row, index) => {
          const m = row.member;
          return [
            `${index + 1}. ${row.wallet}`,
            `   bucket=${row.bucket} tier=${row.priorityTier}`,
            `   UNKNOWN reason=${m.policyAUnknownReason ?? "none"}`,
            `   hydrationEligibility=${row.hydrationEligibilityReason}`,
            `   feedVisible=${m.feedVisibleTradeCount} productionGate=${m.passesProductionWalletGate}`,
            `   tradeGateQualified=${m.tradeGateQualifiedTradeCount}`,
            `   completedPositions=${m.completedPositions ?? "null"} validity=${m.historyValidity ?? "null"}`,
            `   lastHydrationStatus=${row.hydrationStatus ?? "null"} lastHydrationAt=${row.hydrationUpdatedAt ?? "null"}`,
            `   selection=${row.reason}`,
          ].join("\n");
        })
        .join("\n")
  );

  if (DRY_RUN) {
    console.log(
      JSON.stringify(
        {
          mode: "policy_a_bounded_batch_hydration_dry_run",
          preBatchCohort: preSummary,
          selected: selected.map((row) => ({
            wallet: row.wallet,
            bucket: row.bucket,
            reason: row.reason,
            priorityTier: row.priorityTier,
            policyAUnknownReason: row.member.policyAUnknownReason,
            hydrationEligibilityReason: row.hydrationEligibilityReason,
            feedVisibleTradeCount: row.member.feedVisibleTradeCount,
            passesProductionWalletGate: row.member.passesProductionWalletGate,
            tradeGateQualifiedTradeCount: row.member.tradeGateQualifiedTradeCount,
            completedPositions: row.member.completedPositions,
            historyValidity: row.member.historyValidity,
            lastHydrationStatus: row.hydrationStatus,
            lastHydrationAt: row.hydrationUpdatedAt,
          })),
        },
        null,
        2
      )
    );
    return;
  }

  const db = getDb();
  for (const row of selected) {
    await db
      .insert(policyAProductionWalletHydration)
      .values({
        walletAddress: row.wallet,
        priorityTier: row.priorityTier,
        status: "pending",
      })
      .onConflictDoUpdate({
        target: policyAProductionWalletHydration.walletAddress,
        set: { priorityTier: row.priorityTier, status: "pending", updatedAt: new Date() },
      });
  }

  const results: Awaited<ReturnType<typeof hydrateWallet>>[] = [];
  let stopRequested = false;
  let nextIndex = 0;

  async function runWorker(workerId: number): Promise<void> {
    while (true) {
      if (stopRequested) return;
      const index = nextIndex;
      nextIndex += 1;
      if (index >= selected.length) return;
      const row = selected[index]!;
      console.error(
        `[batch${BATCH_NUMBER}] worker=${workerId} hydrating ${row.wallet}`
      );
      await db
        .update(policyAProductionWalletHydration)
        .set({
          status: "running",
          lastAttemptAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(policyAProductionWalletHydration.walletAddress, row.wallet));
      const result = await hydrateWallet(row, {
        shouldAbortBeforePhase2: () => stopRequested,
      });
      results.push(result);
      if (
        result.stoppedBatch &&
        result.finalStatus !== "deferred_infra"
      ) {
        stopRequested = true;
        console.error(
          `[batch${BATCH_NUMBER}] HARD STOP after ${row.wallet}: ${result.stopReason}`
        );
      }
    }
  }

  const workerCount = Math.min(MAX_CONCURRENCY, selected.length);
  await Promise.all(
    Array.from({ length: workerCount }, (_, workerId) => runWorker(workerId + 1))
  );
  const stoppedBatch = stopRequested;

  const postCohort = await buildProductionWalletCohort();
  const postSummary = summarizeCohortCoverage(postCohort.wallets);

  const complete = results.filter((r) => r.finalStatus === "complete");
  const deferred = results.filter((r) => r.finalStatus === "deferred_infra");
  const failed = results.filter((r) => r.finalStatus === "wallet_failed");
  const runtimes = results.map((r) => r.elapsedMs);
  const medianRuntime =
    runtimes.length > 0
      ? runtimes.sort((a, b) => a - b)[Math.floor(runtimes.length / 2)]
      : 0;

  const unknownAfter = postCohort.wallets.filter((w) => w.policyADecision === "UNKNOWN");
  const unknownReasonAfter: Record<string, number> = {};
  for (const member of unknownAfter) {
    const reason = member.policyAUnknownReason ?? "no_indexed_history";
    unknownReasonAfter[reason] = (unknownReasonAfter[reason] ?? 0) + 1;
  }

  const allExactReplay = complete.every((r) => r.exactReplayPass);
  const anySystemicFailure = failed.some(
    (r) => r.stopReason && !isInfraError(new Error(r.stopReason))
  );
  const allNonInfraComplete =
    results.filter((r) => r.finalStatus !== "deferred_infra").length > 0 &&
    results
      .filter((r) => r.finalStatus !== "deferred_infra")
      .every((r) => r.finalStatus === "complete");
  const allLifecycleParity = complete.every((r) => r.lifecycleParity === true);
  const recommendation =
    stoppedBatch || anySystemicFailure
      ? "FIX_REQUIRED"
      : deferred.length > 0 && complete.length === 0
        ? "PAUSE_FOR_SHADOW_OBSERVATION"
        : allExactReplay &&
            allNonInfraComplete &&
            allLifecycleParity &&
            complete.length > 0 &&
            !stoppedBatch
          ? BATCH_NUMBER >= 3
            ? "READY_FOR_BATCH_4_CONCURRENCY_3"
            : "READY_FOR_BATCH_4_CONCURRENCY_2"
          : complete.length > 0
            ? "READY_FOR_BATCH_4_CONCURRENCY_2"
            : "PAUSE_FOR_SHADOW_OBSERVATION";

  console.log(
    JSON.stringify(
      {
        mode: "policy_a_bounded_batch_hydration",
        batch: BATCH_NUMBER,
        maxWallets: MAX_WALLETS,
        maxConcurrency: MAX_CONCURRENCY,
        selected: selected.map((row) => ({
          wallet: row.wallet,
          bucket: row.bucket,
          reason: row.reason,
          policyAUnknownReason: row.member.policyAUnknownReason,
          hydrationEligibilityReason: row.hydrationEligibilityReason,
          feedVisibleTradeCount: row.member.feedVisibleTradeCount,
          passesProductionWalletGate: row.member.passesProductionWalletGate,
          tradeGateQualifiedTradeCount: row.member.tradeGateQualifiedTradeCount,
          completedPositions: row.member.completedPositions,
          historyValidity: row.member.historyValidity,
          lastHydrationStatus: row.hydrationStatus,
          lastHydrationAt: row.hydrationUpdatedAt,
        })),
        preBatchCohort: {
          baseline: BATCH3_STARTING_COHORT,
          measured: preSummary,
        },
        postBatchCohort: {
          measured: postSummary,
          unknownReasonBreakdown: unknownReasonAfter,
          deltaFromBaseline: {
            pass: postSummary.policyAPass - BATCH3_STARTING_COHORT.pass,
            fail: postSummary.policyAFail - BATCH3_STARTING_COHORT.fail,
            unknown: postSummary.policyAUnknown - BATCH3_STARTING_COHORT.unknown,
            total: postSummary.totalWallets - BATCH3_STARTING_COHORT.total,
          },
          deltaFromPreBatch: {
            pass: postSummary.policyAPass - preSummary.policyAPass,
            fail: postSummary.policyAFail - preSummary.policyAFail,
            unknown: postSummary.policyAUnknown - preSummary.policyAUnknown,
            total: postSummary.totalWallets - preSummary.totalWallets,
          },
        },
        batchSummary: {
          attempted: results.length,
          complete: complete.length,
          deferred_infra: deferred.length,
          wallet_failed: failed.length,
          pass: complete.filter((r) => r.after?.policyAVerdict === "PASS").length,
          fail: complete.filter((r) => r.after?.policyAVerdict === "FAIL").length,
          unknown: complete.filter((r) => r.after?.policyAVerdict === "UNKNOWN").length,
          truncationClearedCount: complete.filter((r) => r.truncationCleared).length,
          sourceSpecificSuccesses: complete.filter(
            (r) => r.bucket === "source_specific_semantics"
          ).length,
          earlierIndexSuccesses: complete.filter(
            (r) => r.bucket === "earlier_index"
          ).length,
          medianRuntimeMs: medianRuntime,
          maxRuntimeMs: runtimes.length ? Math.max(...runtimes) : 0,
          totalAuthoritativeEventsPersisted: complete.reduce(
            (sum, r) => sum + (r.reconstruction?.authoritativeCount ?? 0),
            0
          ),
          stoppedEarly: stoppedBatch,
        },
        walletResults: results.map((r) => ({
          wallet: r.wallet,
          priorityReason: r.priorityReason,
          bucket: r.bucket,
          beforeVerdict: r.before.policyAVerdict,
          afterVerdict: r.after?.policyAVerdict ?? null,
          hydrationGate: r.hydrationGate ?? null,
          beforeCompleted: r.before.completedPositions,
          afterCompleted: r.after?.completedPositions ?? null,
          roi: r.after?.realizedRoi ?? null,
          profitableRate: r.after?.profitablePositionRate ?? null,
          historyValidity: r.after?.historyValidity ?? null,
          truncationCleared: r.truncationCleared ?? false,
          earlierScanRequired: r.earlierScanRequired ?? false,
          authoritativeCount: r.reconstruction?.authoritativeCount ?? null,
          exactReplayPass: r.exactReplayPass,
          baselineComplete: r.reconstruction?.baselineComplete ?? null,
          unresolvedChainEventsInLifecycle:
            r.unresolvedChainEventsInLifecycle ?? null,
          classDRecoveryStatus: r.classDRecoveryStatus ?? "not_needed",
          staleLifecyclesDeleted: r.staleLifecyclesDeleted ?? 0,
          phase2Committed: r.phase2Committed ?? false,
          lifecycleParity: r.lifecycleParity ?? null,
          elapsedMs: r.elapsedMs,
          finalStatus: r.finalStatus,
          stopReason: r.stopReason ?? null,
        })),
        recommendation,
        details: results,
      },
      null,
      2
    )
  );

  if (recommendation === "FIX_REQUIRED") {
    process.exit(1);
  }
}

void main().catch((error) => {
  console.error("[policy-a-bounded-batch-hydration] failed:", error);
  process.exit(1);
});
