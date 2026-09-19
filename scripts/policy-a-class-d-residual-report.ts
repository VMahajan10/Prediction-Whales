#!/usr/bin/env tsx
/**
 * Residual class-D recovery taxonomy + deterministic replay gate for 40b9/4e56.
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
import { evaluateHistoricalPerformanceVerdict } from "@/lib/walletLedger/indexed/historicalPerformanceVerdict";
import { WALLET_METRIC_VERSION } from "@/lib/walletLedger/indexed/metricVersion";
import { buildProductionWalletCohort } from "@/lib/walletLedger/indexed/shadow/productionWalletCohort";
import { retryTransient } from "@/lib/walletLedger/indexed/shadow/transientRetry";
import {
  analyzeClassDRecoveryResiduals,
  retryProviderFailedClassDRecovery,
  type ClassDResidualTaxonomy,
} from "@/lib/walletLedger/indexed/store/classDRecovery";
import {
  filterChainAuthoritativeEvents,
} from "@/lib/walletLedger/indexed/store/authoritativePersistence";
import { loadPersistedWalletEvents } from "@/lib/walletLedger/indexed/store/persistWalletHistory";
import {
  compareReplayToSnapshot,
  lifecycleEpisodeKey,
  prepareAuthoritativeEventsForLifecycleMerge,
  replayMetricsFromValidationSnapshot,
  type WalletValidationSnapshot,
} from "@/lib/walletLedger/indexed/store/validationSnapshot";

const WALLETS: Array<{ wallet: string; classDBeforeLifecycle: number }> = [
  { wallet: "0x40b96182a35fbe3c2bb4162e036ecf0c786db002", classDBeforeLifecycle: 6010 },
  { wallet: "0x4e56f1ddaa8f5328036c449b89e731ec748cdee1", classDBeforeLifecycle: 2840 },
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

async function loadPersistedWithRetry(wallet: string) {
  return retryTransient(() => loadPersistedWalletEvents(wallet), {
    maxAttempts: 5,
    label: `loadPersistedWalletEvents:${wallet.slice(0, 8)}`,
  });
}

async function verifyDeterministicReplay(
  wallet: string,
  snapshot: WalletValidationSnapshot
) {
  const persisted = await loadPersistedWithRetry(wallet);
  const persistedChain = prepareAuthoritativeEventsForLifecycleMerge(
    filterChainAuthoritativeEvents(persisted)
  );

  const replayB = await replayMetricsFromValidationSnapshot(snapshot, {
    chainEventsOverride: persistedChain,
    frozen: false,
  });
  const comparison = compareReplayToSnapshot(snapshot, replayB);

  const metricsDeterministic =
    comparison.completedDelta === 0 &&
    comparison.lifecycleEpisodeMatch &&
    comparison.lifecycleEpisodeKeysMatch &&
    Math.abs(comparison.roiDelta) <= 1e-9 &&
    Math.abs(comparison.profitableRateDelta) <= 1e-9;

  const validityGate =
    replayB.metrics.credibilityMetricsValid === false &&
    replayB.metrics.historyValidity === "partial-and-metrics-unsafe" &&
    replayB.fullLedgerMetrics.historyCompletenessReasons.includes(
      "unresolved_chain_order"
    );

  const policyAUnknown = replayB.metrics.policyAVerdict === "UNKNOWN";

  return {
    metricsDeterministic,
    validityGate,
    policyAUnknown,
    exactReplayPass: metricsDeterministic && validityGate && policyAUnknown,
    comparison,
    metrics: replayB.metrics,
    reasons: replayB.fullLedgerMetrics.historyCompletenessReasons,
    replayB,
  };
}

async function updateWalletMetricsFromReplay(
  wallet: string,
  replay: Awaited<ReturnType<typeof replayMetricsFromValidationSnapshot>>
): Promise<void> {
  const metrics = replay.fullLedgerMetrics;
  const db = getDb();
  await db
    .update(walletHistoricalMetrics)
    .set({
      completedPositions: metrics.completedPositionCount,
      medianCapitalAtRisk: metrics.medianCapitalAtRisk,
      resolvedVolumeUsd: metrics.resolvedVolumeUsd,
      profitablePositionRate: metrics.profitablePositionRate,
      outcomeWinRate: metrics.outcomeWinRate,
      realizedRoi: metrics.portfolioRealizedRoi,
      credibilityMetricsValid: metrics.credibilityMetricsValid,
      credibilityDecision: metrics.credibilityMetricsValid,
      historyValidity: metrics.historyValidity,
      historyComplete: metrics.historyComplete,
      credibilityReasons: metrics.historyCompletenessReasons,
      historyIncompleteReasons: metrics.historyCompletenessReasons,
      calculatedAt: new Date(),
    })
    .where(eq(walletHistoricalMetrics.walletAddress, wallet));

  const verdict = evaluateHistoricalPerformanceVerdict({
    indexedDataValidity: metrics.credibilityMetricsValid,
    historyValidity: metrics.historyValidity,
    historyComplete: metrics.historyComplete,
    completedPositionCount: metrics.completedPositionCount,
    realizedRoi: metrics.portfolioRealizedRoi,
    profitablePositionRate: metrics.profitablePositionRate,
    metricVersion: WALLET_METRIC_VERSION,
  }).historicalPerformanceDecision;

  await db
    .update(policyAProductionWalletHydration)
    .set({
      completedPositions: metrics.completedPositionCount,
      historyValidity: metrics.historyValidity,
      policyADecision: verdict,
      updatedAt: new Date(),
    })
    .where(eq(policyAProductionWalletHydration.walletAddress, wallet));
}

function summarizeDominantReason(samples: ClassDResidualTaxonomy["noReceiptMatchSamples"]) {
  const counts: Record<string, number> = {};
  for (const sample of samples) {
    counts[sample.reason] = (counts[sample.reason] ?? 0) + 1;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1]);
}

async function analyzeWallet(spec: { wallet: string; classDBeforeLifecycle: number }) {
  let taxonomy = await analyzeClassDRecoveryResiduals(spec.wallet, {
    classDBeforeLifecycle: spec.classDBeforeLifecycle,
    sampleSize: 20,
  });

  let providerRetry: Awaited<
    ReturnType<typeof retryProviderFailedClassDRecovery>
  > | null = null;
  if (taxonomy.infrastructure.providerFailureTxHashes.length > 0) {
    providerRetry = await retryProviderFailedClassDRecovery(
      spec.wallet,
      taxonomy.infrastructure.providerFailureTxHashes,
      { apply: true }
    );
    taxonomy = await analyzeClassDRecoveryResiduals(spec.wallet, {
      classDBeforeLifecycle: spec.classDBeforeLifecycle,
      sampleSize: 20,
    });
  }

  const recoveredUniqueMatchLifecycle =
    spec.classDBeforeLifecycle - taxonomy.remaining.lifecycleRelevantUnresolved;

  const snapshot = loadLatestSnapshot(spec.wallet);
  if (!snapshot) {
    throw new Error(`missing snapshot for ${spec.wallet}`);
  }
  const replay = await verifyDeterministicReplay(spec.wallet, snapshot);

  if (replay.exactReplayPass) {
    await updateWalletMetricsFromReplay(spec.wallet, replay.replayB);
  }

  const noReceiptDominant = summarizeDominantReason(taxonomy.noReceiptMatchSamples);

  return {
    wallet: spec.wallet,
    taxonomy: {
      classDBeforeLifecycle: spec.classDBeforeLifecycle,
      recoveredUniqueMatchLifecycle,
      recoveryRateLifecyclePct:
        spec.classDBeforeLifecycle > 0
          ? (recoveredUniqueMatchLifecycle / spec.classDBeforeLifecycle) * 100
          : 0,
      currentResiduals: taxonomy.matchPass,
      infrastructure: taxonomy.infrastructure,
      genuineUnresolved: taxonomy.genuineUnresolved,
      remaining: taxonomy.remaining,
      noReceiptDominantReasons: noReceiptDominant,
    },
    providerRetry,
    inspection: {
      noReceiptMatchSamples: taxonomy.noReceiptMatchSamples,
      ambiguousMatchSamples: taxonomy.ambiguousMatchSamples,
    },
    replay,
  };
}

function decideRun2a69(walletReports: Awaited<ReturnType<typeof analyzeWallet>>[]) {
  const providerHeavy = walletReports.some(
    (report) => report.taxonomy.infrastructure.providerFailureTxHashes.length > 0
  );
  const noReceiptDominates = walletReports.some((report) => {
    const { noReceiptMatch, ambiguousMatch } = report.taxonomy.currentResiduals;
    const infra = report.taxonomy.infrastructure.providerFailureEvents;
    return noReceiptMatch > ambiguousMatch && noReceiptMatch > infra;
  });
  const ambiguousDominates = walletReports.some((report) => {
    const { noReceiptMatch, ambiguousMatch } = report.taxonomy.currentResiduals;
    return ambiguousMatch > noReceiptMatch && ambiguousMatch > 0;
  });

  const behavingCorrectly = walletReports.every(
    (report) =>
      report.replay.validityGate &&
      report.replay.policyAUnknown &&
      report.taxonomy.recoveryRateLifecyclePct >= 50
  );

  const run2a69 =
    behavingCorrectly &&
    !providerHeavy &&
    (noReceiptDominates || ambiguousDominates
      ? walletReports.every((r) => r.taxonomy.infrastructure.providerFailureEvents === 0)
      : true);

  return {
    run2a69,
    providerHeavy,
    noReceiptDominates,
    ambiguousDominates,
    behavingCorrectly,
    rationale: run2a69
      ? "40b9/4e56 recovery behaves correctly; residuals appear genuinely unresolvable or infra-cleared."
      : providerHeavy
        ? "Provider/receipt failures remain — fix infra before 2a69."
        : !behavingCorrectly
          ? "Recovery/replay gate not stable on 40b9/4e56 — do not start 2a69."
          : "Residual taxonomy inconclusive — inspect samples before 2a69.",
  };
}

async function main(): Promise<void> {
  if (!isDatabaseEnabled()) {
    console.error("DATABASE_URL not configured");
    process.exit(1);
  }

  const walletReports = [];
  for (const spec of WALLETS) {
    console.error(`[residual-report] analyzing ${spec.wallet}`);
    walletReports.push(await analyzeWallet(spec));
  }

  const decision = decideRun2a69(walletReports);

  let twoA69: Record<string, unknown> | null = null;
  if (decision.run2a69 && process.env.RUN_2A69 === "1") {
    console.error("[residual-report] running 2a69 recovery");
    const spec = {
      wallet: "0x2a69660046d7acc4ab204d7cc5ba78b0776cd2f7",
      classDBeforeLifecycle: 63812,
    };
    twoA69 = {
      ...(await analyzeWallet(spec)),
      note: "2a69 executed after 40b9/4e56 gate passed",
    };
  }

  const cohort = await retryTransient(() => buildProductionWalletCohort(), {
    maxAttempts: 3,
    label: "buildProductionWalletCohort",
  });

  const unresolvedChainOrderUnknown = cohort.wallets.filter((member) => {
    const reasons = member.historyValidity === "partial-and-metrics-unsafe";
    return member.policyADecision === "UNKNOWN" && reasons;
  }).length;

  const report = {
    mode: "policy_a_class_d_residual_report",
    generatedAt: new Date().toISOString(),
    wallets: walletReports,
    decision,
    twoA69,
    cohort: {
      measuredPreBatch2: { total: 77, pass: 11, fail: 27, unknown: 39 },
      measuredPostBatch2BeforeClassD: { total: 77, pass: 13, fail: 30, unknown: 34 },
      correctedCurrent: {
        total: cohort.totalWallets,
        pass: cohort.policyAPass,
        fail: cohort.policyAFail,
        unknown: cohort.policyAUnknown,
      },
      walletsUnknownPartialUnsafe: unresolvedChainOrderUnknown,
    },
    recommendation: decision.run2a69
      ? twoA69 != null
        ? "FIX_REQUIRED_UNTIL_2A69_COMPLETE"
        : "READY_TO_RUN_2A69"
      : "FIX_REQUIRED",
  };

  const outDir = join(process.cwd(), ".cache");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "policy-a-class-d-residual-report.json");
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.error(`\n[wrote] ${outPath}`);
}

void main().catch((error) => {
  console.error("[policy-a-class-d-residual-report] failed:", error);
  process.exit(1);
});
