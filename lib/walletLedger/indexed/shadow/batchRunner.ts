import { sql } from "drizzle-orm";
import { getDb } from "@/lib/crossmarket/store/db";
import { walletShadowBatchStatus } from "@/lib/crossmarket/store/schema";
import {
  EtherscanWalletExecutionBudget,
} from "@/lib/walletLedger/indexed/etherscanQueryController";
import {
  evaluateIndexedProviders,
  runIndexedWalletAudit,
} from "@/lib/walletLedger/indexed/pipeline";
import {
  countWalletLedgerEvents,
  getWalletHistoryIntegrityReport,
  persistIndexedWalletAudit,
  walletHistoryDbEnabled,
} from "@/lib/walletLedger/indexed/store/persistWalletHistory";
import { SMOKE_COHORT_10, type ShadowCohortWallet } from "@/lib/walletLedger/indexed/shadow/cohort";
import {
  buildFull50Cohort,
  buildValidationCohort20,
  FULL50_MIN_COHORT,
  printFull50CohortPreview,
  summarizeCohortGateComposition,
  writeCohortJson,
  type EnrichedCohortWallet,
} from "@/lib/walletLedger/indexed/shadow/cohortV2";
import {
  buildStageCCohort,
  loadStageCCohortFromManifest,
  printStageCCohortPreview,
  STAGE_C_TARGET_COHORT,
} from "@/lib/walletLedger/indexed/shadow/cohortStageC";
import { STAGE_C_BATCH_ID } from "@/lib/walletLedger/indexed/studyVersion";
import { enrichShadowWalletWithHistoricalPerformance } from "@/lib/walletLedger/indexed/historicalPerformanceVerdict";
import { loadProductionCredibilitySnapshot } from "@/lib/walletLedger/indexed/shadow/productionProbe";
import {
  classifyShadowDisagreement,
  type ShadowWalletComparison,
} from "@/lib/walletLedger/indexed/shadow/taxonomy";
import {
  reconcileBatchStatusJournal,
  reclassifyEnospcBatchStatuses,
  reclassifyInfraFailedBatchStatuses,
  resetStaleRunningBatchWallets,
  loadWalletBatchStatus,
  upsertBatchStatusSafe,
} from "@/lib/walletLedger/indexed/shadow/batchStatusJournal";
import {
  nextDeferPerformance,
  readDeferAttempts,
  resolveStageCDeferMaxAttempts,
  scheduleResumableWallets,
  summarizeCohortScheduling,
  markDeferRetryBudgetExhaustedMessage,
  type SchedulingPass,
} from "@/lib/walletLedger/indexed/shadow/batchScheduling";
import {
  InvocationBudget,
  resolveInvocationMaxRuntimeMs,
  resolveInvocationMaxWallets,
} from "@/lib/walletLedger/indexed/shadow/invocationBudget";
import { runBoundedShadowInvocation } from "@/lib/walletLedger/indexed/shadow/boundedInvocationRunner";
import { describeBoundedInvocationStartup } from "@/lib/walletLedger/indexed/shadow/invocationLimits";
import {
  acquireStageCInvocationLock,
  releaseStageCInvocationLock,
} from "@/lib/walletLedger/indexed/shadow/invocationLock";
import { createCombinedAbortSignal } from "@/lib/walletLedger/indexed/shadow/gracefulShutdown";
import { cohortSpecsFromEnriched } from "@/lib/walletLedger/indexed/shadow/productionReconciliation";
import {
  assertDiskSpaceForBatchStart,
  canScheduleMoreWallets,
  DiskSpaceGuardError,
} from "@/lib/walletLedger/indexed/shadow/diskGuard";
import {
  DbCircuitOpenError,
  isDbCircuitOpen,
  withDbCircuit,
} from "@/lib/walletLedger/indexed/shadow/dbCircuitBreaker";
import {
  clearWalletFailures,
  classifyExecutionOutcome,
  getWalletFailureSummary,
  recordWalletFailure,
  resolveExecutionOutcome,
} from "@/lib/walletLedger/indexed/shadow/infraClassification";
import {
  awaitProviderCircuitCooldown,
  isProviderCircuitOpen,
  ProviderCircuitOpenError,
} from "@/lib/walletLedger/indexed/shadow/providerCircuitBreaker";
import {
  observationFromComparisonRow,
  upsertShadowWalletObservation,
  loadShadowWalletObservationsAsRows,
} from "@/lib/walletLedger/indexed/shadow/shadowResultStore";
import { recoverBatchShadowObservations } from "@/lib/walletLedger/indexed/shadow/shadowResultRecovery";
import {
  summarizeShadowBatch,
  writeShadowReports,
} from "@/lib/walletLedger/indexed/shadow/report";

export type ShadowBatchStage =
  | "smoke10"
  | "validation20"
  | "full50"
  | "stageC";

export interface ShadowBatchOptions {
  batchId?: string;
  stage?: ShadowBatchStage;
  wallets?: ShadowCohortWallet[];
  walletConcurrency?: number;
  fullHistory?: boolean;
  resume?: boolean;
  dryRun?: boolean;
  allowSmallCohort?: boolean;
  /** Stage C scheduling: passA = never-attempted only, passB = deferred retries only */
  schedulingPass?: "full" | "passA" | "passB";
  invocationMaxWallets?: number;
  invocationMaxRuntimeMs?: number;
  invocationGracefulShutdownMs?: number;
  invocationForceShutdownMs?: number;
}

async function mapWithConcurrencyGated<T, R>(
  items: T[],
  concurrency: number,
  canScheduleMore: () => boolean,
  fn: (item: T) => Promise<R>,
  onWalletScheduled?: () => void
): Promise<Array<R | undefined>> {
  const results: Array<R | undefined> = new Array(items.length);
  let index = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (index < items.length) {
        if (!canScheduleMore()) break;
        const current = index;
        index += 1;
        if (current >= items.length) break;
        onWalletScheduled?.();
        results[current] = await fn(items[current]!);
      }
    }
  );
  await Promise.all(workers);
  return results;
}

async function clearShadowBatchStatus(batchId: string): Promise<void> {
  if (!walletHistoryDbEnabled()) return;
  const db = getDb();
  await db
    .delete(walletShadowBatchStatus)
    .where(sql`${walletShadowBatchStatus.batchId} = ${batchId}`);
}

async function getResumableWallets(
  batchId: string,
  cohort: ShadowCohortWallet[],
  schedulingPass: SchedulingPass = "full"
): Promise<{
  pending: ShadowCohortWallet[];
  scheduling: ReturnType<typeof summarizeCohortScheduling>;
}> {
  if (!walletHistoryDbEnabled()) {
    const scheduling = summarizeCohortScheduling(cohort, new Map());
    return { pending: cohort, scheduling };
  }
  try {
    const rows = await loadBatchStatusRows(batchId);
    const statusByWallet = new Map(
      rows.map((row) => [row.walletAddress.toLowerCase(), row])
    );
    const scheduling = summarizeCohortScheduling(cohort, statusByWallet);
    console.error(
      `[shadow-batch] scheduling pass=${schedulingPass} cohort=${scheduling.cohortSize} neverAttempted=${scheduling.neverAttempted} deferredRetryable=${scheduling.deferredRetryable} deferredExhausted=${scheduling.deferredExhausted} terminal=${scheduling.terminal} staleRunning=${scheduling.staleRunning} batchConclusionReady=${scheduling.batchConclusionReady}`
    );
    return {
      pending: scheduleResumableWallets(cohort, statusByWallet, schedulingPass),
      scheduling,
    };
  } catch (error) {
    console.error("[shadow-batch] getResumableWallets DB read failed — scheduling full cohort", error);
    const scheduling = summarizeCohortScheduling(cohort, new Map());
    return { pending: cohort, scheduling };
  }
}

function logBoundedInvocationStartup(
  options: ShadowBatchOptions,
  useBoundedSupervisor: boolean,
  invocationBudget: InvocationBudget
): void {
  if (
    invocationBudget.maxWallets == null &&
    invocationBudget.maxRuntimeMs == null
  ) {
    return;
  }
  console.error(
    `[shadow-batch] invocationBudget maxWallets=${invocationBudget.maxWallets ?? "none"} maxRuntimeMs=${invocationBudget.maxRuntimeMs ?? "none"} supervised=${useBoundedSupervisor}`
  );
  if (!useBoundedSupervisor) return;
  const startup = describeBoundedInvocationStartup({
    startedAtMs: invocationBudget.startedAt,
    schedulingMaxRuntimeMs: invocationBudget.maxRuntimeMs,
    gracefulShutdownMs: options.invocationGracefulShutdownMs,
    forceShutdownMs: options.invocationForceShutdownMs,
    supervised: true,
  });
  console.error(
    `[shadow-batch] boundedInvocation policy=${JSON.stringify(startup)}`
  );
}

async function loadBatchStatusRows(batchId: string) {
  if (!walletHistoryDbEnabled()) return [];
  const db = getDb();
  return db
    .select()
    .from(walletShadowBatchStatus)
    .where(sql`${walletShadowBatchStatus.batchId} = ${batchId}`);
}

async function resolveCohort(
  stage: ShadowBatchStage,
  override?: ShadowCohortWallet[]
): Promise<EnrichedCohortWallet[]> {
  if (override?.length) {
    return override.map((wallet) => ({
      ...wallet,
      productionGate: "unknown" as const,
      productionFailureReason: "override_wallet",
      inclusionReason: "cli_override",
    }));
  }
  if (stage === "validation20") {
    const validation = await buildValidationCohort20();
    return validation.map((wallet) => ({
      ...wallet,
      productionGate: wallet.productionGate ?? "unknown",
      productionFailureReason:
        wallet.productionGate === "fail" ? wallet.cohortReason : "n/a",
      inclusionReason: wallet.cohortReason,
    }));
  }
  if (stage === "full50") return buildFull50Cohort();
  if (stage === "stageC") {
    const manifest =
      loadStageCCohortFromManifest() ?? (await buildStageCCohort());
    return manifest.wallets;
  }
  return SMOKE_COHORT_10.map((wallet) => ({
    ...wallet,
    productionGate: "unknown" as const,
    productionFailureReason: "smoke10_anchor",
    inclusionReason: wallet.cohortReason,
  }));
}

function executionStatusFromOutcome(
  outcome: ReturnType<typeof classifyExecutionOutcome>
): ShadowWalletComparison["status"] {
  if (outcome === "deferred_infra") return "deferred_infra";
  if (outcome === "internal_error") return "internal_error";
  return "wallet_failed";
}

function failureEvidence(
  wallet: string,
  error: unknown
): ShadowWalletComparison["evidence"] {
  const summary = getWalletFailureSummary(wallet);
  const message = error instanceof Error ? error.message : String(error);
  return {
    error: message,
    primaryFailure: summary.primaryFailure,
    secondaryFailures: summary.secondaryFailures,
  };
}

function synthesizeInternalErrorRow(
  spec: ShadowCohortWallet,
  error: unknown
): ShadowWalletComparison {
  const message = error instanceof Error ? error.message : String(error);
  return {
    wallet: spec.wallet,
    label: spec.label,
    cohortReason: spec.cohortReason,
    productionDecision: null,
    apiReconstructedDecision: null,
    indexedDecision: false,
    productionCredible: null,
    indexedCredible: false,
    productionAgreement: false,
    apiAgreement: false,
    agreement: false,
    primaryReason: "other",
    productionReasons: ["other"],
    apiReasons: ["other"],
    reasons: ["other"],
    evidence: failureEvidence(spec.wallet, error),
    historyValidity: "unusable",
    historyComplete: false,
    credibilityMetricsValid: false,
    status: "internal_error",
    error: message,
  };
}

function synthesizeWalletFailedRow(
  spec: ShadowCohortWallet,
  error: unknown
): ShadowWalletComparison {
  const message = error instanceof Error ? error.message : String(error);
  return {
    wallet: spec.wallet,
    label: spec.label,
    cohortReason: spec.cohortReason,
    productionDecision: null,
    apiReconstructedDecision: null,
    indexedDecision: false,
    productionCredible: null,
    indexedCredible: false,
    productionAgreement: false,
    apiAgreement: false,
    agreement: false,
    primaryReason: "other",
    productionReasons: ["other"],
    apiReasons: ["other"],
    reasons: ["other"],
    evidence: failureEvidence(spec.wallet, error),
    historyValidity: "unusable",
    historyComplete: false,
    credibilityMetricsValid: false,
    status: "wallet_failed",
    error: message,
  };
}

function synthesizeDeferredInfraRow(
  spec: ShadowCohortWallet,
  error: unknown
): ShadowWalletComparison {
  const message = error instanceof Error ? error.message : String(error);
  return {
    wallet: spec.wallet,
    label: spec.label,
    cohortReason: spec.cohortReason,
    productionDecision: null,
    apiReconstructedDecision: null,
    indexedDecision: false,
    productionCredible: null,
    indexedCredible: false,
    productionAgreement: false,
    apiAgreement: false,
    agreement: false,
    primaryReason: "other",
    productionReasons: ["other"],
    apiReasons: ["other"],
    reasons: ["other"],
    evidence: failureEvidence(spec.wallet, error),
    historyValidity: "unusable",
    historyComplete: false,
    credibilityMetricsValid: false,
    status: "deferred_infra",
    error: message,
  };
}

function synthesizeFailedWalletRow(
  spec: ShadowCohortWallet,
  error: unknown
): ShadowWalletComparison {
  const outcome = resolveExecutionOutcome(spec.wallet, error);
  if (outcome === "deferred_infra") {
    return synthesizeDeferredInfraRow(spec, error);
  }
  if (outcome === "internal_error") {
    return synthesizeInternalErrorRow(spec, error);
  }
  return synthesizeWalletFailedRow(spec, error);
}

async function processWalletSettled(
  input: Parameters<typeof processWallet>[0]
): Promise<ShadowWalletComparison> {
  try {
    return await processWallet(input);
  } catch (error) {
    recordWalletFailure(input.spec.wallet, "process_wallet", error);
    const message = error instanceof Error ? error.message : String(error);
    const outcome = resolveExecutionOutcome(input.spec.wallet, error);
    const status = executionStatusFromOutcome(outcome);
    console.error(
      `[shadow-batch] isolated wallet failure wallet=${input.spec.wallet}: ${message}`
    );
    await upsertBatchStatusSafe({
      batchId: input.batchId,
      wallet: input.spec.wallet,
      status,
      cohortReason: input.spec.cohortReason,
      errorMessage: message,
    });
    return synthesizeFailedWalletRow(input.spec, error);
  } finally {
    clearWalletFailures(input.spec.wallet);
  }
}
async function processWallet(input: {
  batchId: string;
  spec: ShadowCohortWallet;
  providerEvaluations: Awaited<ReturnType<typeof evaluateIndexedProviders>>;
  fullHistory: boolean;
  enableWalletRuntimeBudget?: boolean;
  externalAbortSignal?: AbortSignal;
}): Promise<ShadowWalletComparison> {
  const started = Date.now();
  let eventsBefore = 0;
  clearWalletFailures(input.spec.wallet);
  const walletBudget = input.enableWalletRuntimeBudget
    ? new EtherscanWalletExecutionBudget(input.spec.wallet)
    : null;
  const combinedAbortSignal = createCombinedAbortSignal(
    walletBudget?.signal,
    input.externalAbortSignal
  );

  if (isDbCircuitOpen()) {
    const error = new DbCircuitOpenError("deferred before wallet start");
    await upsertBatchStatusSafe({
      batchId: input.batchId,
      wallet: input.spec.wallet,
      status: "deferred_infra",
      cohortReason: input.spec.cohortReason,
      errorMessage: error.message,
    });
    return synthesizeDeferredInfraRow(input.spec, error);
  }
  if (isProviderCircuitOpen()) {
    const allowed = await awaitProviderCircuitCooldown();
    if (!allowed) {
      const error = new ProviderCircuitOpenError("deferred before wallet start");
      await upsertBatchStatusSafe({
        batchId: input.batchId,
        wallet: input.spec.wallet,
        status: "deferred_infra",
        cohortReason: input.spec.cohortReason,
        errorMessage: error.message,
      });
      return synthesizeDeferredInfraRow(input.spec, error);
    }
  }

  const priorStatus = await loadWalletBatchStatus(
    input.batchId,
    input.spec.wallet
  );

  await upsertBatchStatusSafe({
    batchId: input.batchId,
    wallet: input.spec.wallet,
    status: "running",
    cohortReason: input.spec.cohortReason,
  });

  try {
    eventsBefore = walletHistoryDbEnabled()
      ? await withDbCircuit("countWalletLedgerEvents", () =>
          countWalletLedgerEvents(input.spec.wallet)
        )
      : 0;
    const prodStarted = Date.now();
    const production = await loadProductionCredibilitySnapshot(input.spec.wallet);
    const productionProbeMs = Date.now() - prodStarted;

    const auditStarted = Date.now();
    const audit = await runIndexedWalletAudit({
      label: input.spec.label,
      wallet: input.spec.wallet,
      transactionHash: input.spec.transactionHash,
      providerId: "etherscan_v2",
      providerEvaluations: input.providerEvaluations,
      fullHistory: input.fullHistory,
      resumeCheckpoint: true,
      abortSignal: combinedAbortSignal,
    });
    const auditMs = Date.now() - auditStarted;

    let persistStats: Awaited<ReturnType<typeof persistIndexedWalletAudit>> | null =
      null;
    const persistStarted = Date.now();
    if (walletHistoryDbEnabled()) {
      persistStats = await persistIndexedWalletAudit(audit, {
        abortSignal: combinedAbortSignal,
      });
    }
    const persistTotalMs = Date.now() - persistStarted;

    const eventsAfter = walletHistoryDbEnabled()
      ? await withDbCircuit("countWalletLedgerEventsAfter", () =>
          countWalletLedgerEvents(input.spec.wallet)
        )
      : 0;

    const metrics = audit.indexedLedgerMetrics;
    const apiCredibility = audit.apiCredibility;
    const indexedCredibility = audit.indexedCredibility;
    const productionDecision = production.productionCredible;
    const apiReconstructedDecision =
      apiCredibility?.credibilityDecision ?? audit.credibilityMetricsValidBefore;
    const indexedDecision =
      indexedCredibility?.credibilityDecision ?? audit.credibilityMetricsValidAfter;
    const disagreement = classifyShadowDisagreement({ production, audit });
    const historyValidity =
      indexedCredibility?.historyValidity ?? metrics?.historyValidity ?? "unusable";
    const status =
      historyValidity === "unusable" || historyValidity === "partial-and-metrics-unsafe"
        ? "unusable"
        : "complete";

    const stageTimings = audit.stageTimingsMs ?? {};
    const performance = nextDeferPerformance(priorStatus ?? undefined, {
      totalMs: Date.now() - started,
      productionProbeMs,
      auditMs,
      persistTotalMs,
      etherscanMs: audit.fetchStats.elapsedMs,
      timestampMs: audit.blockTimestampStats?.elapsedMs ?? 0,
      gammaMs: audit.gammaPrefetchStats?.elapsedMs ?? 0,
      etherscanRequests: audit.fetchStats.requests,
      rpcAttempts: audit.blockTimestampStats?.rpcAttempts ?? 0,
      timestampCacheHitPct:
        audit.blockTimestampStats && audit.blockTimestampStats.requestedUnique > 0
          ? audit.blockTimestampStats.hits /
            audit.blockTimestampStats.requestedUnique
          : 1,
      eventsBefore,
      eventsAfter,
      newPersistedEvents: eventsAfter - eventsBefore,
      stageTimings,
      dbWrites: persistStats
        ? {
            auditIndexedEvents: persistStats.auditIndexedEvents,
            candidateEventsPresentedToPersistence:
              persistStats.candidateEventsPresentedToPersistence,
            eventsInserted: persistStats.eventsUpserted,
            eventsSkippedExisting: persistStats.eventsSkippedExisting,
            eventChunks: persistStats.eventWriteStats.chunkCount,
            eventLoadKeysMs: persistStats.eventWriteStats.loadExistingKeysMs,
            eventWriteMs: persistStats.eventWriteStats.writeMs,
            positionsWriteMs: persistStats.positionsWriteMs,
            lifecycleMode: persistStats.lifecycleStats.lifecycleMode,
            lifecyclesAffected: persistStats.lifecycleStats.lifecyclesAffected,
            lifecyclesInserted: persistStats.lifecycleStats.lifecyclesInserted,
            lifecyclesUpdated: persistStats.lifecycleStats.lifecyclesUpdated,
            lifecyclesUnchanged: persistStats.lifecycleStats.lifecyclesUnchanged,
            metricsWriteMs: persistStats.metricsWriteMs,
            coverageWriteMs: persistStats.coverageWriteMs,
          }
        : null,
      shadowDecisions: {
        productionDecision,
        apiReconstructedDecision,
        indexedDecision,
      },
    });

    const row = enrichShadowWalletWithHistoricalPerformance(
      {
        wallet: input.spec.wallet,
        label: input.spec.label,
        cohortReason: input.spec.cohortReason,
        productionDecision,
        apiReconstructedDecision,
        indexedDecision,
        productionCredible: productionDecision,
        indexedCredible: indexedDecision,
        productionAgreement: productionDecision === indexedDecision,
        apiAgreement: apiReconstructedDecision === indexedDecision,
        agreement: productionDecision === indexedDecision,
        primaryReason: disagreement.primaryReason,
        productionReasons: disagreement.productionReasons,
        apiReasons: disagreement.apiReasons,
        reasons: disagreement.productionReasons,
        evidence: disagreement.evidence,
        historyValidity,
        historyComplete:
          indexedCredibility?.historyComplete ?? metrics?.historyComplete ?? false,
        credibilityMetricsValid: indexedDecision,
        status,
        performance,
      },
      {
        completedPositions:
          audit.indexedCompletedPositions ??
          metrics?.completedPositionCount ??
          null,
        realizedRoi: metrics?.portfolioRealizedRoi ?? null,
        profitablePositionRate: metrics?.profitablePositionRate ?? null,
      }
    );

    await upsertBatchStatusSafe({
      batchId: input.batchId,
      wallet: input.spec.wallet,
      status: row.status,
      cohortReason: input.spec.cohortReason,
      performance,
    });

    await upsertShadowWalletObservation(
      observationFromComparisonRow(input.batchId, row, {
        production: "captured_evaluation",
        api: "captured_evaluation",
        indexed: "captured_evaluation",
      })
    );

    return row;
  } catch (error) {
    recordWalletFailure(input.spec.wallet, "process_wallet", error);
    const message = error instanceof Error ? error.message : String(error);
    const outcome = resolveExecutionOutcome(input.spec.wallet, error);
    const status = executionStatusFromOutcome(outcome);
    const performance = nextDeferPerformance(
      priorStatus ?? undefined,
      { totalMs: Date.now() - started },
      status === "deferred_infra"
    );
    const deferAttempts = readDeferAttempts(performance);
    const deferMax = resolveStageCDeferMaxAttempts();
    const errorMessage =
      status === "deferred_infra" && deferAttempts >= deferMax
        ? markDeferRetryBudgetExhaustedMessage(message)
        : message;
    await upsertBatchStatusSafe({
      batchId: input.batchId,
      wallet: input.spec.wallet,
      status,
      cohortReason: input.spec.cohortReason,
      errorMessage,
      performance,
    });
    if (status === "deferred_infra") {
      return synthesizeDeferredInfraRow(input.spec, error);
    }
    if (status === "internal_error") {
      return synthesizeInternalErrorRow(input.spec, error);
    }
    return {
      ...synthesizeWalletFailedRow(input.spec, error),
      performance: { totalMs: Date.now() - started },
    };
  } finally {
    walletBudget?.stop();
  }
}

export async function runSingleShadowWallet(
  input: Parameters<typeof processWallet>[0]
): Promise<ShadowWalletComparison> {
  return processWalletSettled(input);
}

async function finalizeShadowBatchRun(input: {
  batchId: string;
  cohort: EnrichedCohortWallet[];
  freshRows: ShadowWalletComparison[];
  resume: boolean;
  infraInterrupted: boolean;
}): Promise<{
  batchId: string;
  cohort: EnrichedCohortWallet[];
  rows: ShadowWalletComparison[];
  summary: ReturnType<typeof summarizeShadowBatch>;
  reportPaths?: { jsonPath: string; mdPath: string };
  integrity?: Awaited<ReturnType<typeof getWalletHistoryIntegrityReport>>;
}> {
  let priorStatus: Awaited<ReturnType<typeof loadBatchStatusRows>> = [];
  if (input.resume) {
    try {
      priorStatus = await loadBatchStatusRows(input.batchId);
    } catch (error) {
      console.error(
        "[shadow-batch] final status DB read failed — using in-memory rows + journal",
        error
      );
    }
  }
  const mergedRows = await mergeAttemptedRows(
    input.batchId,
    input.cohort,
    input.freshRows,
    priorStatus
  );
  const cohortSpecs = cohortSpecsFromEnriched(input.cohort);
  const statusRows = await loadBatchStatusRows(input.batchId);
  const statusByWallet = new Map(
    statusRows.map((row) => [row.walletAddress.toLowerCase(), row])
  );
  const scheduling = summarizeCohortScheduling(input.cohort, statusByWallet);
  const batchComplete =
    !input.infraInterrupted && scheduling.batchConclusionReady;
  const summary = summarizeShadowBatch({
    batchId: input.batchId,
    cohort: cohortSpecs,
    rows: mergedRows,
    batchComplete,
    infraInterrupted: input.infraInterrupted,
  });
  let integrity: Awaited<ReturnType<typeof getWalletHistoryIntegrityReport>> | undefined;
  try {
    integrity = await getWalletHistoryIntegrityReport();
  } catch (error) {
    console.error("[shadow-batch] integrity report skipped — DB unavailable", error);
  }
  const reportPaths = writeShadowReports({
    batchId: input.batchId,
    rows: mergedRows,
    summary,
    cohort: cohortSpecs,
    integrity,
  });
  return {
    batchId: input.batchId,
    cohort: input.cohort,
    rows: mergedRows,
    summary,
    reportPaths,
    integrity,
  };
}

export async function runShadowCredibilityBatch(
  options: ShadowBatchOptions = {}
): Promise<{
  batchId: string;
  cohort: EnrichedCohortWallet[];
  rows: ShadowWalletComparison[];
  summary: ReturnType<typeof summarizeShadowBatch>;
  reportPaths?: { jsonPath: string; mdPath: string };
  integrity?: Awaited<ReturnType<typeof getWalletHistoryIntegrityReport>>;
  dryRun?: boolean;
}> {
  if (!walletHistoryDbEnabled()) {
    throw new Error("DATABASE_URL required for Phase 2E.1 shadow batch");
  }

  const stage = options.stage ?? "smoke10";
  const batchId =
    options.batchId ??
    (stage === "stageC"
      ? STAGE_C_BATCH_ID
      : new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19));
  const concurrency = options.walletConcurrency ?? 2;
  const fullHistory = options.fullHistory ?? true;

  const cohort = await resolveCohort(stage, options.wallets);
  const composition = summarizeCohortGateComposition(cohort);

  console.error(
    `[shadow-batch] stage=${stage} requestedCohortSize=${
      stage === "full50" ? FULL50_MIN_COHORT : cohort.length
    } selectedWalletCount=${cohort.length} candidateWalletCount=${composition.selected}`
  );

  if (stage === "full50") {
    printFull50CohortPreview(cohort, stage);
    const cohortPath = writeCohortJson(batchId, cohort);
    console.error(`[shadow-batch] Cohort JSON: ${cohortPath}`);
    if (
      cohort.length < FULL50_MIN_COHORT &&
      !options.allowSmallCohort &&
      !options.dryRun
    ) {
      throw new Error(
        `full50 cohort selected only ${cohort.length} wallets (<${FULL50_MIN_COHORT}). ` +
          "Use --allow-small-cohort to override."
      );
    }
  }

  if (stage === "stageC") {
    const manifest =
      loadStageCCohortFromManifest() ??
      (await buildStageCCohort({ forceRebuild: true }));
    printStageCCohortPreview(manifest);
    console.error(
      `[shadow-batch] Stage C manifest: tmp/wallet-history/phase2e2-stageC-cohort.json`
    );
    if (
      cohort.length < STAGE_C_TARGET_COHORT * 0.75 &&
      !options.allowSmallCohort &&
      !options.dryRun
    ) {
      throw new Error(
        `stageC cohort selected only ${cohort.length} wallets (<${Math.round(STAGE_C_TARGET_COHORT * 0.75)}). ` +
          "Use --allow-small-cohort to override."
      );
    }
  }

  const invocationBudget = new InvocationBudget(
    resolveInvocationMaxWallets(options.invocationMaxWallets),
    resolveInvocationMaxRuntimeMs(options.invocationMaxRuntimeMs)
  );
  const useBoundedSupervisor =
    invocationBudget.maxWallets != null || invocationBudget.maxRuntimeMs != null;

  if (options.dryRun) {
    logBoundedInvocationStartup(options, useBoundedSupervisor, invocationBudget);
    if (stage === "stageC") {
      const schedulingPass = options.schedulingPass ?? "full";
      const { pending, scheduling } = await getResumableWallets(
        batchId,
        cohort,
        schedulingPass
      );
      const passAPoolSize =
        schedulingPass === "passA" ? scheduling.neverAttempted : scheduling.neverAttempted;
      console.error(
        `[shadow-batch] batchId=${batchId} batchStatusRowsCreated=${cohort.length} passAPoolSize=${passAPoolSize} invocationQueueSize=${pending.length} walletsActuallyStarted=0 walletsFinished=0`
      );
    }
    return {
      batchId,
      cohort,
      rows: [],
      summary: summarizeShadowBatch({ batchId, cohort, rows: [] }),
      dryRun: true,
    };
  }

  assertDiskSpaceForBatchStart();

  if (options.resume === false) {
    await clearShadowBatchStatus(batchId);
    console.error(
      `[shadow-batch] Cleared prior status rows for batchId=${batchId} (no-resume restart)`
    );
  } else {
    const journal = await reconcileBatchStatusJournal(batchId);
    if (journal.reconciled > 0) {
      console.error(
        `[shadow-batch] reconciled ${journal.reconciled} journaled status rows for batchId=${batchId}`
      );
    }
    const reclassified = await reclassifyInfraFailedBatchStatuses(batchId);
    if (reclassified > 0) {
      console.error(
        `[shadow-batch] reclassified ${reclassified} infra-failed wallets to deferred_infra for batchId=${batchId}`
      );
    }
    const enospcReclassified = await reclassifyEnospcBatchStatuses(batchId);
    if (enospcReclassified > 0) {
      console.error(
        `[shadow-batch] reclassified ${enospcReclassified} ENOSPC wallet_failed rows to deferred_infra for batchId=${batchId}`
      );
    }
    const resetCount = await resetStaleRunningBatchWallets(batchId);
    if (resetCount > 0) {
      console.error(
        `[shadow-batch] reset ${resetCount} stale running wallets to pending for batchId=${batchId}`
      );
    }
  }
  const schedulingPass = options.schedulingPass ?? "full";
  const resumable =
    options.resume === false
      ? {
          pending: cohort,
          scheduling: summarizeCohortScheduling(cohort, new Map()),
        }
      : await getResumableWallets(batchId, cohort, schedulingPass);
  const pending = resumable.pending;

  if (
    stage === "stageC" &&
    (invocationBudget.maxWallets != null || invocationBudget.maxRuntimeMs != null) &&
    !useBoundedSupervisor
  ) {
    throw new Error(
      "stageC invocation limits require bounded supervisor mode"
    );
  }

  if (useBoundedSupervisor && stage === "stageC") {
    acquireStageCInvocationLock(batchId);
  }

  logBoundedInvocationStartup(options, useBoundedSupervisor, invocationBudget);

  const passAPoolSize = resumable.scheduling.neverAttempted;
  console.error(
    `[shadow-batch] batchId=${batchId} batchStatusRowsCreated=${cohort.length} passAPoolSize=${passAPoolSize} invocationQueueSize=${pending.length} walletsActuallyStarted=0 walletsFinished=0`
  );

  const providerEvaluations = await evaluateIndexedProviders();
  let infraInterrupted = false;
  let shutdownFailure = false;

  let allRows: ShadowWalletComparison[] = [];
  try {
    if (useBoundedSupervisor) {
      const bounded = await runBoundedShadowInvocation({
        batchId,
        pending,
        fullHistory,
        enableWalletRuntimeBudget: stage === "stageC",
        invocationMaxWallets: options.invocationMaxWallets,
        invocationMaxRuntimeMs: options.invocationMaxRuntimeMs,
        invocationGracefulShutdownMs: options.invocationGracefulShutdownMs,
        invocationForceShutdownMs: options.invocationForceShutdownMs,
        onForcedParentExit: async () => {
          releaseStageCInvocationLock();
        },
      });
      allRows = bounded.rows;
      infraInterrupted = bounded.infraInterrupted;
      shutdownFailure = bounded.shutdownFailure;
    } else {
      const gatedResults = await mapWithConcurrencyGated(
        pending,
        concurrency,
        () =>
          canScheduleMoreWallets() &&
          !isDbCircuitOpen() &&
          !isProviderCircuitOpen() &&
          invocationBudget.canScheduleNextWallet(),
        (spec) =>
          processWalletSettled({
            batchId,
            spec,
            providerEvaluations,
            fullHistory,
            enableWalletRuntimeBudget: stage === "stageC",
          }),
        () => invocationBudget.markWalletScheduled()
      );
      const invocationExhausted = invocationBudget.exhaustedReason();
      if (invocationExhausted) {
        console.error(
          `[shadow-batch] invocation budget reached reason=${invocationExhausted} snapshot=${JSON.stringify(invocationBudget.snapshot())}`
        );
        infraInterrupted = true;
      }
      allRows = gatedResults.filter(
        (row): row is ShadowWalletComparison => row != null
      );
    }
  } finally {
    if (useBoundedSupervisor && stage === "stageC") {
      releaseStageCInvocationLock();
    }
  }

  if (isDbCircuitOpen() || isProviderCircuitOpen() || !canScheduleMoreWallets()) {
    if (!canScheduleMoreWallets()) {
      console.error(
        "[shadow-batch] disk guard tripped — stopping new wallet scheduling (resumable)"
      );
    }
    infraInterrupted = true;
  }
  if (shutdownFailure) {
    console.error(
      "[shadow-batch] bounded invocation shutdown failure — worker required forced termination"
    );
    infraInterrupted = true;
  }

  const finalized = await finalizeShadowBatchRun({
    batchId,
    cohort,
    freshRows: allRows,
    resume: options.resume !== false,
    infraInterrupted,
  });

  console.error(
    `[shadow-batch] complete=${finalized.summary.metricsSafe} metricsUnsafe=${finalized.summary.metricsUnsafe} unusable=${finalized.summary.unusableValidity} walletFailed=${finalized.summary.walletFailed} deferredInfra=${finalized.summary.deferredInfra} pending=${finalized.summary.pending} infraInterrupted=${finalized.summary.infraInterrupted}`
  );

  return finalized;
}

async function mergeAttemptedRows(
  batchId: string,
  cohort: EnrichedCohortWallet[],
  freshRows: ShadowWalletComparison[],
  _priorStatus: Array<{
    walletAddress: string;
    status: string;
    errorMessage: string | null;
    performance: Record<string, unknown> | null;
  }>
): Promise<ShadowWalletComparison[]> {
  for (const row of freshRows) {
    await upsertShadowWalletObservation(
      observationFromComparisonRow(batchId, row, {
        production: "captured_evaluation",
        api: "captured_evaluation",
        indexed: "captured_evaluation",
      })
    );
  }

  await recoverBatchShadowObservations(batchId, { persist: true });
  const loaded = await loadShadowWalletObservationsAsRows(batchId);
  const byWallet = new Map(
    loaded.map((row) => [row.wallet.toLowerCase(), row])
  );
  for (const row of freshRows) {
    byWallet.set(row.wallet.toLowerCase(), row);
  }
  return cohort
    .map((spec) => byWallet.get(spec.wallet.toLowerCase()))
    .filter((row): row is ShadowWalletComparison => row != null);
}
