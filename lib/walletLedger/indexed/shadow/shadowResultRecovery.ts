import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/crossmarket/store/db";
import {
  walletHistoricalMetrics,
  walletShadowBatchStatus,
} from "@/lib/crossmarket/store/schema";
import { QUERY_PLAN_VERSION } from "@/lib/walletLedger/indexed/checkpoint";
import { WALLET_METRIC_VERSION } from "@/lib/walletLedger/indexed/metricVersion";
import {
  productionGateToDecision,
  readPersistedShadowDecisions,
  type CohortProductionSpec,
} from "@/lib/walletLedger/indexed/shadow/productionReconciliation";
import {
  upsertBatchStatusSafe,
} from "@/lib/walletLedger/indexed/shadow/batchStatusJournal";
import {
  comparisonRowFromObservation,
  type ShadowObservationSource,
  type ShadowWalletObservation,
  upsertShadowWalletObservation,
} from "@/lib/walletLedger/indexed/shadow/shadowResultStore";
import type {
  ShadowDisagreementReason,
  ShadowWalletComparison,
} from "@/lib/walletLedger/indexed/shadow/taxonomy";

export interface IndexedMetricsRow {
  credibilityDecision: boolean;
  historyValidity: string;
  historyComplete: boolean;
  credibilityReasons: string[];
  completedPositions: number;
  medianCapitalAtRisk: number | null;
  resolvedVolumeUsd: number | null;
  realizedRoi: number | null;
  profitablePositionRate: number | null;
}

export interface BatchStatusRow {
  walletAddress: string;
  status: string;
  cohortReason: string | null;
  errorMessage: string | null;
  performance: Record<string, unknown> | null;
}

function hasCapturedEvidence(row: ShadowWalletComparison | undefined): boolean {
  if (!row) return false;
  const keys = Object.keys(row.evidence ?? {});
  return keys.length > 5;
}

function normalizeStatus(status: string): ShadowWalletComparison["status"] {
  if (status === "complete") return "complete";
  if (status === "wallet_failed") return "wallet_failed";
  if (status === "deferred_infra") return "deferred_infra";
  if (status === "internal_error") return "internal_error";
  if (status === "failed") return "deferred_infra";
  return "unusable";
}

export async function loadBatchStatusRows(
  batchId: string
): Promise<BatchStatusRow[]> {
  const db = getDb();
  const rows = await db
    .select({
      walletAddress: walletShadowBatchStatus.walletAddress,
      status: walletShadowBatchStatus.status,
      cohortReason: walletShadowBatchStatus.cohortReason,
      errorMessage: walletShadowBatchStatus.errorMessage,
      performance: walletShadowBatchStatus.performance,
    })
    .from(walletShadowBatchStatus)
    .where(sql`${walletShadowBatchStatus.batchId} = ${batchId}`);
  return rows.map((row) => ({
    walletAddress: row.walletAddress.toLowerCase(),
    status: row.status,
    cohortReason: row.cohortReason,
    errorMessage: row.errorMessage,
    performance: row.performance ?? null,
  }));
}

export async function loadIndexedMetricsByWallet(
  wallets: string[]
): Promise<Map<string, IndexedMetricsRow>> {
  const db = getDb();
  const walletSet = new Set(wallets.map((w) => w.toLowerCase()));
  const rows = await db
    .select()
    .from(walletHistoricalMetrics)
    .where(sql`${walletHistoricalMetrics.metricVersion} = ${WALLET_METRIC_VERSION}`);
  const map = new Map<string, IndexedMetricsRow>();
  for (const row of rows) {
    const key = row.walletAddress.toLowerCase();
    if (!walletSet.has(key)) continue;
    map.set(key, {
      credibilityDecision: row.credibilityDecision,
      historyValidity: row.historyValidity,
      historyComplete: row.historyComplete,
      credibilityReasons: row.credibilityReasons ?? [],
      completedPositions: row.completedPositions,
      medianCapitalAtRisk: row.medianCapitalAtRisk,
      resolvedVolumeUsd: row.resolvedVolumeUsd,
      realizedRoi: row.realizedRoi,
      profitablePositionRate: row.profitablePositionRate,
    });
  }
  return map;
}

export function loadCohortSpecs(batchId: string): CohortProductionSpec[] {
  const cohortPath = join(
    process.cwd(),
    "tmp",
    "wallet-history",
    "shadow-compare",
    `cohort-${batchId}.json`
  );
  if (!existsSync(cohortPath)) {
    throw new Error(`Missing cohort manifest: ${cohortPath}`);
  }
  const cohortFile = JSON.parse(readFileSync(cohortPath, "utf8")) as {
    wallets: CohortProductionSpec[];
  };
  return cohortFile.wallets.map((wallet) => ({
    wallet: wallet.wallet.toLowerCase(),
    label: wallet.label,
    cohortReason: wallet.cohortReason,
    productionGate: wallet.productionGate,
    productionFailureReason: wallet.productionFailureReason,
  }));
}

export function loadArtifactShadowRows(
  batchId: string
): Map<string, ShadowWalletComparison> {
  const shadowPath = join(
    process.cwd(),
    "tmp",
    "wallet-history",
    "shadow-compare",
    `shadow-${batchId}.json`
  );
  const candidates = [
    shadowPath.replace(".json", "-pre-reconcile.json"),
    shadowPath,
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const saved = JSON.parse(readFileSync(path, "utf8")) as {
      rows: ShadowWalletComparison[];
    };
    return new Map(
      saved.rows.map((row) => [row.wallet.toLowerCase(), row])
    );
  }
  return new Map();
}

export function recoverShadowWalletObservation(input: {
  batchId: string;
  cohort: CohortProductionSpec;
  status: BatchStatusRow;
  artifactRow?: ShadowWalletComparison;
  indexedMetrics?: IndexedMetricsRow | null;
}): ShadowWalletObservation {
  const wallet = input.cohort.wallet.toLowerCase();
  const artifact = input.artifactRow;
  const persisted = readPersistedShadowDecisions(input.status.performance);
  const indexed = input.indexedMetrics ?? null;
  const executionStatus = normalizeStatus(input.status.status);

  let productionDecision: boolean | null = null;
  let productionSource: ShadowObservationSource = "comparison_metadata_missing";
  let apiDecision: boolean | null = null;
  let apiSource: ShadowObservationSource = "comparison_metadata_missing";
  let indexedDecision = false;
  let indexedSource: ShadowObservationSource = "comparison_metadata_missing";

  if (artifact) {
    if (
      artifact.productionDecision != null ||
      artifact.evidence.productionDecision != null
    ) {
      productionDecision =
        artifact.productionDecision ?? artifact.evidence.productionDecision ?? null;
      productionSource = "captured_evaluation";
    }
    if (
      artifact.apiReconstructedDecision != null ||
      artifact.evidence.apiReconstructedDecision != null
    ) {
      apiDecision =
        artifact.apiReconstructedDecision ??
        artifact.evidence.apiReconstructedDecision ??
        null;
      apiSource = "captured_evaluation";
    }
    if (artifact.indexedDecision || artifact.evidence.indexedDecision) {
      indexedDecision = Boolean(
        artifact.indexedDecision ?? artifact.evidence.indexedDecision
      );
      indexedSource = "captured_evaluation";
    }
  }

  if (productionDecision == null && persisted?.productionDecision != null) {
    productionDecision = persisted.productionDecision;
    productionSource = "captured_evaluation";
  }
  if (apiDecision == null && persisted?.apiReconstructedDecision != null) {
    apiDecision = persisted.apiReconstructedDecision;
    apiSource = "captured_evaluation";
  }
  if (!indexedDecision && persisted?.indexedDecision) {
    indexedDecision = persisted.indexedDecision;
    indexedSource = "captured_evaluation";
  }

  if (productionDecision == null && input.cohort.productionGate != null) {
    productionDecision = productionGateToDecision(input.cohort.productionGate);
    productionSource = "cohort_gate_snapshot";
  }

  if (indexed) {
    indexedDecision = indexed.credibilityDecision;
    indexedSource = "persisted_indexed_audit";
  } else if (indexedSource === "comparison_metadata_missing") {
    indexedDecision = artifact?.indexedDecision ?? false;
  }

  const historyValidity =
    indexed?.historyValidity ??
    artifact?.historyValidity ??
    (executionStatus === "complete"
      ? "partial-but-metrics-safe"
      : "unusable");
  const historyComplete = indexed?.historyComplete ?? artifact?.historyComplete ?? false;
  const credibilityMetricsValid =
    indexed?.credibilityDecision ?? artifact?.credibilityMetricsValid ?? false;

  const productionReasons =
    artifact?.productionReasons ??
    (input.cohort.productionFailureReason &&
    input.cohort.productionFailureReason !== "ok"
      ? [input.cohort.productionFailureReason as ShadowDisagreementReason]
      : []);
  const apiReasons = artifact?.apiReasons ?? [];
  const indexedReasons =
    (indexed?.credibilityReasons as ShadowDisagreementReason[]) ??
    artifact?.reasons ??
    [];

  const evidence = {
    ...(artifact?.evidence ?? {}),
    productionDecision,
    apiReconstructedDecision: apiDecision,
    indexedDecision,
    productionObservationSource: productionSource,
    apiObservationSource: apiSource,
    indexedObservationSource: indexedSource,
    productionResolvedPositions:
      artifact?.evidence.productionResolvedPositions ?? null,
    productionAvgEv: artifact?.evidence.productionAvgEv ?? null,
    apiEvents: artifact?.evidence.apiEvents ?? null,
    apiReconstructedCompletedPositions:
      artifact?.evidence.apiReconstructedCompletedPositions ?? null,
    apiReconstructedRoi: artifact?.evidence.apiReconstructedRoi ?? null,
    indexedEvents: artifact?.evidence.indexedEvents ?? null,
    indexedCompletedPositions:
      indexed?.completedPositions ??
      artifact?.evidence.indexedCompletedPositions ??
      null,
    indexedRealizedRoi:
      indexed?.realizedRoi ?? artifact?.evidence.indexedRealizedRoi ?? null,
    eventsBeforeApiBoundary: artifact?.evidence.eventsBeforeApiBoundary ?? null,
    timestampCoveragePct: artifact?.evidence.timestampCoveragePct ?? null,
    hydrationStatus: artifact?.evidence.hydrationStatus ?? null,
  };

  const comparisonMetadataMissing =
    (productionSource === "comparison_metadata_missing" &&
      input.cohort.productionGate == null) ||
    indexedSource === "comparison_metadata_missing";

  return {
    batchId: input.batchId,
    wallet,
    label: input.cohort.label,
    cohortReason: input.cohort.cohortReason,
    executionStatus,
    historyValidity,
    historyComplete,
    credibilityMetricsValid,
    productionDecision,
    productionReasons,
    productionMetricsSnapshot: {
      productionResolvedPositions: evidence.productionResolvedPositions,
      productionAvgEv: evidence.productionAvgEv,
      hydrationStatus: evidence.hydrationStatus,
    },
    apiReconstructedDecision: apiDecision,
    apiReasons,
    apiMetricsSnapshot: {
      apiEvents: evidence.apiEvents,
      apiReconstructedCompletedPositions: evidence.apiReconstructedCompletedPositions,
      apiReconstructedRoi: evidence.apiReconstructedRoi,
    },
    indexedDecision,
    indexedReasons,
    indexedMetricsSnapshot: {
      indexedCompletedPositions: evidence.indexedCompletedPositions,
      indexedRealizedRoi: evidence.indexedRealizedRoi,
      medianCapitalAtRisk: indexed?.medianCapitalAtRisk ?? null,
      resolvedVolumeUsd: indexed?.resolvedVolumeUsd ?? null,
      profitablePositionRate: indexed?.profitablePositionRate ?? null,
    },
    evidence,
    comparisonMetadataMissing,
    productionObservationSource: productionSource,
    apiObservationSource: apiSource,
    indexedObservationSource: indexedSource,
    metricVersion: WALLET_METRIC_VERSION,
    queryPlanVersion: QUERY_PLAN_VERSION,
    evaluatedAt: artifact?.performance
      ? new Date().toISOString()
      : null,
    performance: input.status.performance ?? undefined,
    error: input.status.errorMessage ?? undefined,
  };
}

export async function loadBatchWalletAddresses(batchId: string): Promise<string[]> {
  const rows = await loadBatchStatusRows(batchId);
  return rows.map((row) => row.walletAddress.toLowerCase());
}

export async function loadCohortSpecsAsync(
  batchId: string,
  options: {
    fallbackCohort?: CohortProductionSpec[];
  } = {}
): Promise<CohortProductionSpec[]> {
  const cohortPath = join(
    process.cwd(),
    "tmp",
    "wallet-history",
    "shadow-compare",
    `cohort-${batchId}.json`
  );
  if (existsSync(cohortPath)) {
    return loadCohortSpecs(batchId);
  }
  const statusRows = await loadBatchStatusRows(batchId);
  const fallbackByWallet = new Map(
    (options.fallbackCohort ?? []).map((spec) => [
      spec.wallet.toLowerCase(),
      spec,
    ])
  );
  return statusRows.map((row) => {
    const wallet = row.walletAddress.toLowerCase();
    const fallback = fallbackByWallet.get(wallet);
    return {
      wallet,
      label: fallback?.label ?? wallet.slice(0, 10),
      cohortReason: row.cohortReason ?? fallback?.cohortReason ?? "batch_status",
      productionGate: fallback?.productionGate,
      productionFailureReason: fallback?.productionFailureReason,
    };
  });
}

/** Promote deferred_infra rows that already have durable indexed metrics to complete. */
export async function reconcileMisclassifiedDeferredBatchStatuses(
  batchId: string
): Promise<number> {
  const statusRows = await loadBatchStatusRows(batchId);
  const metrics = await loadIndexedMetricsByWallet(
    statusRows.map((row) => row.walletAddress)
  );
  let changed = 0;
  for (const row of statusRows) {
    if (row.status !== "deferred_infra") continue;
    const indexed = metrics.get(row.walletAddress.toLowerCase());
    if (!indexed?.credibilityDecision) continue;
    if (
      indexed.historyValidity === "unusable" ||
      indexed.historyValidity === "partial-and-metrics-unsafe"
    ) {
      continue;
    }
    const result = await upsertBatchStatusSafe({
      batchId,
      wallet: row.walletAddress,
      status: "complete",
      cohortReason: row.cohortReason ?? undefined,
      performance: row.performance ?? undefined,
    });
    if (result.persisted) changed += 1;
  }
  return changed;
}

export async function recoverBatchShadowObservationsForCohort(
  batchId: string,
  cohort: CohortProductionSpec[],
  options: { persist?: boolean } = {}
): Promise<ShadowWalletObservation[]> {
  const statusRows = await loadBatchStatusRows(batchId);
  const statusByWallet = new Map(
    statusRows.map((row) => [row.walletAddress.toLowerCase(), row])
  );
  const artifactRows = loadArtifactShadowRows(batchId);
  const indexedMetrics = await loadIndexedMetricsByWallet(
    cohort.map((wallet) => wallet.wallet)
  );

  const observations: ShadowWalletObservation[] = [];
  for (const spec of cohort) {
    const wallet = spec.wallet.toLowerCase();
    const status = statusByWallet.get(wallet);
    if (!status) continue;
    const observation = recoverShadowWalletObservation({
      batchId,
      cohort: spec,
      status,
      artifactRow: artifactRows.get(wallet),
      indexedMetrics: indexedMetrics.get(wallet) ?? null,
    });
    observations.push(observation);
    if (options.persist) {
      await upsertShadowWalletObservation(observation);
    }
  }
  return observations;
}

export async function recoverBatchShadowObservations(
  batchId: string,
  options: { persist?: boolean; fallbackCohort?: CohortProductionSpec[] } = {}
): Promise<ShadowWalletObservation[]> {
  const cohort = await loadCohortSpecsAsync(batchId, {
    fallbackCohort: options.fallbackCohort,
  });
  return recoverBatchShadowObservationsForCohort(batchId, cohort, options);
}

export function observationsToComparisonRows(
  observations: ShadowWalletObservation[]
): ShadowWalletComparison[] {
  return observations.map(comparisonRowFromObservation);
}

export interface ValidationOverlapRow {
  wallet: string;
  validation20: {
    A: boolean | null;
    B: boolean | null;
    C: boolean;
    validity: string;
    metricsSafe: boolean;
    productionSource: string;
    apiSource: string;
    indexedSource: string;
  } | null;
  full50: {
    A: boolean | null;
    B: boolean | null;
    C: boolean;
    validity: string;
    metricsSafe: boolean;
    productionSource: string;
    apiSource: string;
    indexedSource: string;
  };
  changed: {
    production: boolean;
    indexed: boolean;
    validity: boolean;
    metricsSafe: boolean;
  };
  explanation: string[];
}

export function buildValidationOverlapReport(
  validationObservations: ShadowWalletObservation[],
  full50Observations: ShadowWalletObservation[]
): ValidationOverlapRow[] {
  const validationByWallet = new Map(
    validationObservations.map((row) => [row.wallet.toLowerCase(), row])
  );
  const overlaps: ValidationOverlapRow[] = [];
  for (const full of full50Observations) {
    const validation = validationByWallet.get(full.wallet.toLowerCase());
    if (!validation) continue;
    const changed = {
      production: validation.productionDecision !== full.productionDecision,
      indexed: validation.indexedDecision !== full.indexedDecision,
      validity: validation.historyValidity !== full.historyValidity,
      metricsSafe:
        (validation.executionStatus === "complete") !==
        (full.executionStatus === "complete"),
    };
    const explanation: string[] = [];
    if (changed.production) {
      explanation.push(
        `production decision ${validation.productionDecision} -> ${full.productionDecision} (${validation.productionObservationSource} -> ${full.productionObservationSource})`
      );
    }
    if (changed.indexed) {
      explanation.push(
        `indexed decision ${validation.indexedDecision} -> ${full.indexedDecision}`
      );
    }
    if (changed.validity) {
      explanation.push(
        `history validity ${validation.historyValidity} -> ${full.historyValidity}`
      );
    }
    if (changed.metricsSafe) {
      explanation.push(
        `execution status ${validation.executionStatus} -> ${full.executionStatus}`
      );
    }
    if (explanation.length === 0) {
      explanation.push("stable across validation20 and full50-v2");
    }
    overlaps.push({
      wallet: full.wallet,
      validation20: {
        A: validation.productionDecision,
        B: validation.apiReconstructedDecision,
        C: validation.indexedDecision,
        validity: validation.historyValidity,
        metricsSafe: validation.executionStatus === "complete",
        productionSource: validation.productionObservationSource,
        apiSource: validation.apiObservationSource,
        indexedSource: validation.indexedObservationSource,
      },
      full50: {
        A: full.productionDecision,
        B: full.apiReconstructedDecision,
        C: full.indexedDecision,
        validity: full.historyValidity,
        metricsSafe: full.executionStatus === "complete",
        productionSource: full.productionObservationSource,
        apiSource: full.apiObservationSource,
        indexedSource: full.indexedObservationSource,
      },
      changed,
      explanation,
    });
  }
  return overlaps;
}
