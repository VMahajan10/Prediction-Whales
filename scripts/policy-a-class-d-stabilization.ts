#!/usr/bin/env tsx
/**
 * Policy A class-D recovery stabilization for 40b9/4e56 (NOT 2a69).
 */
import "../tests/preload-env";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq, inArray } from "drizzle-orm";
import { getDb, isDatabaseEnabled } from "@/lib/crossmarket/store/db";
import {
  policyAProductionWalletHydration,
  walletHistoricalMetrics,
} from "@/lib/crossmarket/store/schema";
import { buildProductionWalletCohort } from "@/lib/walletLedger/indexed/shadow/productionWalletCohort";
import { retryTransient } from "@/lib/walletLedger/indexed/shadow/transientRetry";
import {
  analyzeAmbiguityTaxonomy,
  analyzeClassDRecoveryResiduals,
  applyPendingUniqueClassDMatches,
  auditReceiptCache,
  buildNormalizedClassDCounts,
  classifyClassDResidualEvents,
  retryInfraFailedTxHashesOnly,
} from "@/lib/walletLedger/indexed/store/classDRecovery";
import { filterChainAuthoritativeEvents } from "@/lib/walletLedger/indexed/store/authoritativePersistence";
import { loadPersistedWalletEvents } from "@/lib/walletLedger/indexed/store/persistWalletHistory";
import { assessUnresolvedChainOrder } from "@/lib/walletLedger/indexed/store/unresolvedChainOrder";
import {
  analyzeMetricMovementFromSnapshots,
  buildPostRecoveryValidationSnapshot,
  compareReplayToSnapshot,
  prepareAuthoritativeEventsForLifecycleMerge,
  replayMetricsFromValidationSnapshot,
  saveValidationSnapshot,
  type WalletValidationSnapshot,
} from "@/lib/walletLedger/indexed/store/validationSnapshot";

const WALLETS = [
  {
    wallet: "0x40b96182a35fbe3c2bb4162e036ecf0c786db002",
    classDBeforeLifecycle: 6010,
  },
  {
    wallet: "0x4e56f1ddaa8f5328036c449b89e731ec748cdee1",
    classDBeforeLifecycle: 2840,
  },
] as const;

const CHECK_WALLETS = [
  ...WALLETS.map((row) => row.wallet),
  "0x2a69660046d7acc4ab204d7cc5ba78b0776cd2f7",
];

function loadLatestSnapshot(wallet: string): WalletValidationSnapshot | null {
  const dir = join(process.cwd(), ".cache", "wallet-validation-snapshots");
  const prefix = wallet.toLowerCase();
  const match = readdirSync(dir)
    .filter((file) => file.startsWith(prefix))
    .sort()
    .at(-1);
  if (!match) return null;
  return JSON.parse(
    readFileSync(join(dir, match), "utf8")
  ) as WalletValidationSnapshot;
}

async function queryDurableValidityState(wallets: string[]) {
  const db = getDb();
  const metrics = await db
    .select()
    .from(walletHistoricalMetrics)
    .where(inArray(walletHistoricalMetrics.walletAddress, wallets));
  const hydration = await db
    .select()
    .from(policyAProductionWalletHydration)
    .where(inArray(policyAProductionWalletHydration.walletAddress, wallets));

  return wallets.map((wallet) => {
    const metric = metrics.find(
      (row) => row.walletAddress.toLowerCase() === wallet.toLowerCase()
    );
    const hydrate = hydration.find(
      (row) => row.walletAddress.toLowerCase() === wallet.toLowerCase()
    );
    return {
      wallet,
      credibilityMetricsValid: metric?.credibilityMetricsValid ?? null,
      historyValidity: metric?.historyValidity ?? null,
      policyADecision: hydrate?.policyADecision ?? null,
      validityReasons: metric?.credibilityReasons ?? metric?.historyIncompleteReasons ?? [],
      hydrationStatus: hydrate?.hydrationStatus ?? null,
      metricsUpdatedAt: metric?.calculatedAt?.toISOString() ?? null,
      hydrationUpdatedAt: hydrate?.updatedAt?.toISOString() ?? null,
    };
  });
}

async function stabilizeWallet(spec: {
  wallet: string;
  classDBeforeLifecycle: number;
}) {
  const wallet = spec.wallet.toLowerCase();
  console.error(`[stabilization] ${wallet.slice(0, 8)} step=initial-taxonomy`);
  const initialTaxonomy = await analyzeClassDRecoveryResiduals(wallet, {
    classDBeforeLifecycle: spec.classDBeforeLifecycle,
    sampleSize: 25,
  });
  const normalizedBefore = await buildNormalizedClassDCounts(
    wallet,
    spec.classDBeforeLifecycle
  );

  console.error(`[stabilization] ${wallet.slice(0, 8)} step=provider-retry`);
  const providerRetry = await retryInfraFailedTxHashesOnly(
    wallet,
    initialTaxonomy.infrastructure.providerFailureTxHashes,
    { apply: true }
  );

  console.error(`[stabilization] ${wallet.slice(0, 8)} step=apply-pending`);
  const pendingApply = await applyPendingUniqueClassDMatches(wallet);

  console.error(`[stabilization] ${wallet.slice(0, 8)} step=disambiguation-apply`);
  const recoveryPass = await applyPendingUniqueClassDMatches(wallet);

  console.error(`[stabilization] ${wallet.slice(0, 8)} step=final-taxonomy`);
  const finalTaxonomy = await analyzeClassDRecoveryResiduals(wallet, {
    classDBeforeLifecycle: spec.classDBeforeLifecycle,
    sampleSize: 25,
  });
  const normalizedAfter = await buildNormalizedClassDCounts(
    wallet,
    spec.classDBeforeLifecycle
  );
  const ambiguity = await analyzeAmbiguityTaxonomy(wallet, 50);

  const events = await loadPersistedWalletEvents(wallet);
  const unresolved = assessUnresolvedChainOrder(events);
  const classifications = await classifyClassDResidualEvents(wallet);
  const lifecycleUnresolved = classifications.filter(
    (row) => row.inLifecycle && row.outcome !== "unique_match"
  );
  const infraUnresolved = lifecycleUnresolved.filter(
    (row) => row.providerFailure || row.outcome === "receipt_unavailable"
  ).length;
  const ambiguousUnresolved = lifecycleUnresolved.filter(
    (row) => row.outcome === "unresolved_ambiguous_receipt_match"
  ).length;
  const noMatchUnresolved = lifecycleUnresolved.filter(
    (row) => row.outcome === "unresolved_no_receipt_match"
  ).length;

  const priorSnapshot = loadLatestSnapshot(wallet);
  if (!priorSnapshot) {
    throw new Error(`missing prior snapshot for ${wallet}`);
  }
  const oldReplay = await replayMetricsFromValidationSnapshot(priorSnapshot, {
    chainEventsOverride: priorSnapshot.authoritativeEvents,
    frozen: true,
  });

  console.error(`[stabilization] ${wallet.slice(0, 8)} step=post-recovery-snapshot`);
  const chainEvents = prepareAuthoritativeEventsForLifecycleMerge(
    filterChainAuthoritativeEvents(events)
  );
  const postRecoverySnapshot = await buildPostRecoveryValidationSnapshot({
    wallet,
    priorSnapshot,
    authoritativeEvents: chainEvents,
    runId: `${wallet.slice(2, 10)}-post-recovery-${Date.now().toString(36)}`,
  });
  const snapshotPath = await saveValidationSnapshot(postRecoverySnapshot);
  const postRecoveryReplay = await replayMetricsFromValidationSnapshot(
    postRecoverySnapshot,
    { frozen: true }
  );
  const postRecoveryComparison = compareReplayToSnapshot(
    postRecoverySnapshot,
    postRecoveryReplay
  );
  const exactReplayPass =
    postRecoveryReplay.replayLifecycleInputSequenceHash ===
      postRecoverySnapshot.auditLifecycleInputSequenceHash &&
    postRecoveryComparison.exactMatch &&
    postRecoveryReplay.metrics.credibilityMetricsValid === false &&
    postRecoveryReplay.metrics.historyValidity ===
      "partial-and-metrics-unsafe" &&
    postRecoveryReplay.fullLedgerMetrics.historyCompletenessReasons.includes(
      "unresolved_chain_order"
    );

  const metricMovement = analyzeMetricMovementFromSnapshots({
    oldSnapshot: priorSnapshot,
    newSnapshot: postRecoverySnapshot,
    oldReplay,
    newReplay: postRecoveryReplay,
  });

  return {
    wallet,
    initialTaxonomy,
    normalizedBefore,
    providerRetry,
    pendingApply,
    recoveryPass,
    finalTaxonomy,
    normalizedAfter,
    ambiguity,
    remaining: {
      lifecycleClassDBefore: spec.classDBeforeLifecycle,
      recoveredCanonical:
        spec.classDBeforeLifecycle -
        unresolved.unresolvedChainEventsInLifecycle,
      unresolvedInfra: infraUnresolved,
      unresolvedAmbiguous: ambiguousUnresolved,
      unresolvedNoMatch: noMatchUnresolved,
      remainingLifecycleRelevantUnresolved:
        unresolved.unresolvedChainEventsInLifecycle,
    },
    postRecoverySnapshot: {
      path: snapshotPath,
      throughBlock: postRecoverySnapshot.throughBlock,
      auditLifecycleInputSequenceHash:
        postRecoverySnapshot.auditLifecycleInputSequenceHash,
      replayLifecycleInputSequenceHash:
        postRecoveryReplay.replayLifecycleInputSequenceHash,
      auditMetrics: postRecoverySnapshot.auditMetrics,
      exactReplayPass,
      comparison: postRecoveryComparison,
    },
    metricMovement,
    oldMetrics: priorSnapshot.auditMetrics,
    newMetrics: postRecoverySnapshot.auditMetrics,
  };
}

function decideRecommendation(
  walletReports: Awaited<ReturnType<typeof stabilizeWallet>>[]
): "READY_TO_RUN_2A69" | "FIX_REQUIRED" {
  const infraCleared = walletReports.every(
    (report) => report.providerRetry.stillInfraFailed === 0
  );
  const pendingCleared = walletReports.every(
    (report) => report.normalizedAfter.pendingUniqueMatchesNotApplied === 0
  );
  const applyConflicts = walletReports.every(
    (report) => (report.pendingApply.applyFailures ?? 0) === 0
  );
  const exactReplayOk = walletReports.every(
    (report) => report.postRecoverySnapshot.exactReplayPass
  );
  const validityGateOk = walletReports.every(
    (report) =>
      report.postRecoverySnapshot.auditMetrics.credibilityMetricsValid ===
        false &&
      report.postRecoverySnapshot.auditMetrics.policyAVerdict === "UNKNOWN"
  );

  if (
    infraCleared &&
    pendingCleared &&
    applyConflicts &&
    exactReplayOk &&
    validityGateOk
  ) {
    return "READY_TO_RUN_2A69";
  }
  return "FIX_REQUIRED";
}

async function main(): Promise<void> {
  if (!isDatabaseEnabled()) {
    console.error("DATABASE_URL not configured");
    process.exit(1);
  }

  const receiptCacheAudit = auditReceiptCache();
  const walletReports = [];
  for (const spec of WALLETS) {
    walletReports.push(await stabilizeWallet(spec));
  }

  const durableValidity = await queryDurableValidityState(CHECK_WALLETS);
  const cohort = await retryTransient(() => buildProductionWalletCohort(), {
    maxAttempts: 3,
    label: "buildProductionWalletCohort",
  });
  const cohortCounts = cohort.wallets.reduce(
    (acc, member) => {
      const decision = member.policyADecision ?? "UNKNOWN";
      if (decision === "PASS") acc.pass += 1;
      else if (decision === "FAIL") acc.fail += 1;
      else acc.unknown += 1;
      return acc;
    },
    { pass: 0, fail: 0, unknown: 0 }
  );

  const recommendation = decideRecommendation(walletReports);
  const report = {
    mode: "policy_a_class_d_stabilization",
    recommendation,
    A_receiptCache: {
      rootCause:
        "legacy cache treated any JSON blob as success; empty receipts and provider failures were cached permanently as usable receipts",
      audit: receiptCacheAudit,
    },
    B_providerRetry: walletReports.map((row) => ({
      wallet: row.wallet,
      ...row.providerRetry,
    })),
    C_pendingMatchApply: walletReports.map((row) => ({
      wallet: row.wallet,
      rootCause: row.pendingApply.rootCause,
      before: row.normalizedBefore,
      apply: row.pendingApply,
      after: row.normalizedAfter,
    })),
    D_ambiguityTaxonomy: walletReports.map((row) => row.ambiguity),
    E_remainingUnresolved: walletReports.map((row) => row.remaining),
    F_postRecoveryExactReplay: walletReports.map((row) => row.postRecoverySnapshot),
    G_metricMovement: walletReports.map((row) => ({
      wallet: row.wallet,
      oldMetrics: row.oldMetrics,
      newMetrics: row.newMetrics,
      movement: row.metricMovement,
    })),
    H_durableValidityState: durableValidity,
    I_cohortSnapshot: {
      pass: cohortCounts.pass,
      fail: cohortCounts.fail,
      unknown: cohortCounts.unknown,
      note:
        "cohort totals read from buildProductionWalletCohort(); compare with H for stale derived rows",
    },
    J_recommendation: recommendation,
  };

  const outDir = join(process.cwd(), ".cache");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "policy-a-class-d-stabilization-report.json");
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, reportPath: outPath }, null, 2));
}

void main().catch((error) => {
  console.error("[policy-a-class-d-stabilization] failed:", error);
  process.exit(1);
});
