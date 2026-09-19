#!/usr/bin/env tsx
/**
 * Policy A class-D reconciliation finalization + durable fail-closed refresh.
 */
import "../tests/preload-env";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { getDb, isDatabaseEnabled } from "@/lib/crossmarket/store/db";
import {
  policyAProductionWalletHydration,
  walletHistoricalMetrics,
} from "@/lib/crossmarket/store/schema";
import { buildProductionWalletCohort } from "@/lib/walletLedger/indexed/shadow/productionWalletCohort";
import { retryTransient } from "@/lib/walletLedger/indexed/shadow/transientRetry";
import {
  applyPendingUniqueClassDMatches,
  diagnoseReconciliationConflicts,
} from "@/lib/walletLedger/indexed/store/classDRecovery";
import { filterChainAuthoritativeEvents } from "@/lib/walletLedger/indexed/store/authoritativePersistence";
import {
  assessClassDRecoveryQueueStatus,
  commitFailClosedValidityFromSnapshot,
} from "@/lib/walletLedger/indexed/store/durableValidityRefresh";
import { loadPersistedWalletEvents } from "@/lib/walletLedger/indexed/store/persistWalletHistory";
import { assessUnresolvedChainOrder } from "@/lib/walletLedger/indexed/store/unresolvedChainOrder";
import {
  buildPostRecoveryValidationSnapshot,
  prepareAuthoritativeEventsForLifecycleMerge,
  saveValidationSnapshot,
  type WalletValidationSnapshot,
} from "@/lib/walletLedger/indexed/store/validationSnapshot";

const WALLETS_40B9_4E56 = [
  {
    wallet: "0x40b96182a35fbe3c2bb4162e036ecf0c786db002",
    classDBeforeLifecycle: 6010,
  },
  {
    wallet: "0x4e56f1ddaa8f5328036c449b89e731ec748cdee1",
    classDBeforeLifecycle: 2840,
  },
] as const;

const WALLET_2A69 = {
  wallet: "0x2a69660046d7acc4ab204d7cc5ba78b0776cd2f7",
  classDBeforeLifecycle: 63812,
};

function loadLatestSnapshot(
  wallet: string,
  preferPostRecovery = false
): WalletValidationSnapshot | null {
  const dir = join(process.cwd(), ".cache", "wallet-validation-snapshots");
  const prefix = wallet.toLowerCase();
  const files = readdirSync(dir)
    .filter((file) => file.startsWith(prefix))
    .sort();
  const match = preferPostRecovery
    ? files.filter((file) => file.includes("post-recovery")).at(-1) ??
      files.at(-1)
    : files.at(-1);
  if (!match) return null;
  return JSON.parse(
    readFileSync(join(dir, match), "utf8")
  ) as WalletValidationSnapshot;
}

async function queryDurableRow(wallet: string) {
  const db = getDb();
  const [metric] = await db
    .select()
    .from(walletHistoricalMetrics)
    .where(eq(walletHistoricalMetrics.walletAddress, wallet.toLowerCase()))
    .limit(1);
  const [hydration] = await db
    .select()
    .from(policyAProductionWalletHydration)
    .where(eq(policyAProductionWalletHydration.walletAddress, wallet.toLowerCase()))
    .limit(1);
  return {
    wallet,
    credibilityMetricsValid: metric?.credibilityMetricsValid ?? null,
    historyValidity: metric?.historyValidity ?? null,
    policyADecision: hydration?.policyADecision ?? null,
    reasons:
      metric?.credibilityReasons ??
      metric?.historyIncompleteReasons ??
      [],
    updatedAt: metric?.calculatedAt?.toISOString() ?? null,
  };
}

async function finalizeWallet(spec: {
  wallet: string;
  classDBeforeLifecycle: number;
}) {
  const wallet = spec.wallet.toLowerCase();
  console.error(`[finalization] ${wallet.slice(0, 8)} diagnose conflicts`);
  const conflictDiagnosis = await diagnoseReconciliationConflicts(wallet);

  console.error(`[finalization] ${wallet.slice(0, 8)} re-apply pending`);
  const applyReport = await applyPendingUniqueClassDMatches(wallet);

  console.error(`[finalization] ${wallet.slice(0, 8)} durable refresh`);
  const priorSnapshot = loadLatestSnapshot(wallet, true);
  if (!priorSnapshot) {
    throw new Error(`missing snapshot for ${wallet}`);
  }
  const events = await loadPersistedWalletEvents(wallet);
  const postRecoverySnapshot = await buildPostRecoveryValidationSnapshot({
    wallet,
    priorSnapshot,
    authoritativeEvents: prepareAuthoritativeEventsForLifecycleMerge(
      filterChainAuthoritativeEvents(events)
    ),
    runId: `${wallet.slice(2, 10)}-final-${Date.now().toString(36)}`,
  });
  const snapshotPath = await saveValidationSnapshot(postRecoverySnapshot);
  const durableRefresh = await commitFailClosedValidityFromSnapshot(
    wallet,
    postRecoverySnapshot,
    { preservePerformanceMetrics: true, requireExactReplay: true }
  );

  const unresolved = assessUnresolvedChainOrder(events);
  const classDRecoveryStatus = assessClassDRecoveryQueueStatus({
    lifecycleRelevantUnresolved: unresolved.unresolvedChainEventsInLifecycle,
    lifecycleClassDBefore: spec.classDBeforeLifecycle,
  });

  return {
    wallet,
    conflictDiagnosis,
    applyReport,
    durableRefresh,
    snapshotPath,
    classDRecoveryStatus,
    durableRowAfter: await queryDurableRow(wallet),
  };
}

async function audit2a69ValidityOnly() {
  const wallet = WALLET_2A69.wallet.toLowerCase();
  console.error(`[finalization] ${wallet.slice(0, 8)} read-only audit`);
  const priorSnapshot = loadLatestSnapshot(wallet);
  if (!priorSnapshot) {
    throw new Error(`missing snapshot for ${wallet}`);
  }
  const events = await loadPersistedWalletEvents(wallet);
  const postRecoverySnapshot = await buildPostRecoveryValidationSnapshot({
    wallet,
    priorSnapshot,
    authoritativeEvents: prepareAuthoritativeEventsForLifecycleMerge(
      filterChainAuthoritativeEvents(events)
    ),
    runId: `${wallet.slice(2, 10)}-validity-audit-${Date.now().toString(36)}`,
  });
  const snapshotPath = await saveValidationSnapshot(postRecoverySnapshot);
  const durableRefresh = await commitFailClosedValidityFromSnapshot(
    wallet,
    postRecoverySnapshot,
    { preservePerformanceMetrics: true, requireExactReplay: true }
  );
  const unresolved = assessUnresolvedChainOrder(events);
  return {
    wallet,
    durableRefresh,
    snapshotPath,
    unresolvedChainEventsInLifecycle: unresolved.unresolvedChainEventsInLifecycle,
    classDRecoveryStatus: assessClassDRecoveryQueueStatus({
      lifecycleRelevantUnresolved: unresolved.unresolvedChainEventsInLifecycle,
      lifecycleClassDBefore: WALLET_2A69.classDBeforeLifecycle,
    }),
    durableRowAfter: await queryDurableRow(wallet),
    note: "validity-only refresh; receipt recovery not started",
  };
}

function decideBatch3Gate(input: {
  walletReports: Awaited<ReturnType<typeof finalizeWallet>>[];
  twoA69: Awaited<ReturnType<typeof audit2a69ValidityOnly>>;
  cohort: Awaited<ReturnType<typeof buildProductionWalletCohort>>;
}) {
  const staleVerdicts = ["0x40b96182a35fbe3c2bb4162e036ecf0c786db002", "0x4e56f1ddaa8f5328036c449b89e731ec748cdee1", WALLET_2A69.wallet]
    .map((wallet) =>
      input.walletReports.find((row) => row.wallet === wallet.toLowerCase()) ??
      (wallet.toLowerCase() === WALLET_2A69.wallet.toLowerCase()
        ? input.twoA69
        : null)
    )
    .filter(Boolean);

  const allRefreshed = staleVerdicts.every(
    (row) =>
      row!.durableRowAfter.credibilityMetricsValid === false &&
      row!.durableRowAfter.policyADecision === "UNKNOWN"
  );
  const exactReplayOk = [
    ...input.walletReports.map((row) => row.durableRefresh.exactReplayPass),
    input.twoA69.durableRefresh.exactReplayPass,
  ].every(Boolean);
  const reconciliationSilentBlock = input.walletReports.some(
    (row) =>
      row.applyReport.remainingPending > 0 &&
      row.conflictDiagnosis.categories
        .A_same_wallet_same_log_equivalent_economics +
        row.conflictDiagnosis.categories.C_legacy_duplicate_of_canonical >
        0 &&
      row.applyReport.legacyDuplicatesRetired === 0 &&
      row.applyReport.canonicalAlreadySatisfied === 0
  );

  if (allRefreshed && exactReplayOk && !reconciliationSilentBlock) {
    return "READY_FOR_BATCH_3_CONCURRENCY_2";
  }
  return "FIX_REQUIRED";
}

async function main(): Promise<void> {
  if (!isDatabaseEnabled()) {
    console.error("DATABASE_URL not configured");
    process.exit(1);
  }

  const walletReports = [];
  for (const spec of WALLETS_40B9_4E56) {
    walletReports.push(await finalizeWallet(spec));
  }

  const twoA69 = await audit2a69ValidityOnly();

  const cohort = await retryTransient(() => buildProductionWalletCohort(), {
    maxAttempts: 3,
    label: "buildProductionWalletCohort",
  });

  const evaluable = cohort.wallets.filter(
    (member) => member.policyADecision === "PASS" || member.policyADecision === "FAIL"
  ).length;
  const validDurable = cohort.wallets.filter(
    (member) => member.hasValidDurableCoverage
  ).length;

  const batch3Gate = decideBatch3Gate({ walletReports, twoA69, cohort });

  const report = {
    mode: "policy_a_class_d_finalization",
    batch3Gate,
    conflictDiagnosis: walletReports.map((row) => row.conflictDiagnosis),
    reapply: walletReports.map((row) => row.applyReport),
    durableRefresh: walletReports.map((row) => ({
      wallet: row.wallet,
      ...row.durableRefresh,
      classDRecoveryStatus: row.classDRecoveryStatus,
      durableRowAfter: row.durableRowAfter,
    })),
    twoA69,
    cohort: {
      pass: cohort.policyAPass,
      fail: cohort.policyAFail,
      unknown: cohort.policyAUnknown,
      evaluablePct:
        cohort.totalWallets > 0
          ? (evaluable / cohort.totalWallets) * 100
          : 0,
      validDurableCoveragePct:
        cohort.totalWallets > 0
          ? (validDurable / cohort.totalWallets) * 100
          : 0,
      unknownReasonBreakdown: cohort.unknownReasonBreakdown,
    },
    twoA69RecoveryRecommendation:
      twoA69.unresolvedChainEventsInLifecycle > 10000
        ? "defer_class_d_recovery_low_feed_visibility"
        : "consider_class_d_recovery_if_high_priority",
  };

  const outPath = join(
    process.cwd(),
    ".cache",
    "policy-a-class-d-finalization-report.json"
  );
  mkdirSync(join(process.cwd(), ".cache"), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, reportPath: outPath }, null, 2));
}

void main().catch((error) => {
  console.error("[policy-a-class-d-finalization] failed:", error);
  process.exit(1);
});
