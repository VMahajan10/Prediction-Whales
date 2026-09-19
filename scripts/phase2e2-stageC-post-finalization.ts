#!/usr/bin/env tsx
/**
 * Stage C post-finalization reconciliation report (read-only + optional finalize flag).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import "./preload-env";
import { sql, eq, and, desc } from "drizzle-orm";
import { getDb } from "@/lib/crossmarket/store/db";
import {
  walletHistoricalMetrics,
  walletHistoryCoverage,
  walletShadowBatchStatus,
  walletShadowResults,
} from "@/lib/crossmarket/store/schema";
import { WALLET_METRIC_VERSION } from "@/lib/walletLedger/indexed/metricVersion";
import {
  readBatchStatusJournal,
  reconcileBatchStatusJournal,
} from "@/lib/walletLedger/indexed/shadow/batchStatusJournal";
import { readDeferAttempts } from "@/lib/walletLedger/indexed/shadow/batchScheduling";
import { buildStageCInterimReport } from "@/lib/walletLedger/indexed/shadow/stageCInterimAnalysis";
import { STAGE_C_COHORT_PATH } from "@/lib/walletLedger/indexed/shadow/stageCInterimAnalysis";
import {
  classifyMutuallyExclusiveBatchBucket,
  verifyDurableEligibleWallets,
} from "@/lib/walletLedger/indexed/shadow/stageCReconciliation";
import { STAGE_C_BATCH_ID } from "@/lib/walletLedger/indexed/studyVersion";

const LATEST_PASS_A_LOG = join(
  process.cwd(),
  "tmp/wallet-history/phase2e2-stageC-passA-20260910-030800.log"
);
const INVOCATION_WALLETS = [
  "0xc69bd5567b40ef4d11922eaa57e1f9be1c642076",
  "0xf3ef6ac0c8c8b8e8f8a8b8c8d8e8f8a8b8c8d8e",
  "0x59018ff1c8c8b8e8f8a8b8c8d8e8f8a8b8c8d8e",
];

function parseArgs(argv: string[]): { finalize: boolean } {
  return { finalize: argv.includes("--finalize") };
}

function resolveInvocationWalletsFromLog(logPath: string): string[] {
  const text = readFileSync(logPath, "utf8");
  const matches = [
    ...text.matchAll(/positions_fetch wallet=(0x[a-f0-9]{8})/gi),
  ].map((m) => m[1]!.toLowerCase());
  const prefixes = [...new Set(matches)];
  const cohort: Array<{ wallet: string }> = JSON.parse(
    readFileSync(STAGE_C_COHORT_PATH, "utf8")
  ).wallets;
  const resolved: string[] = [];
  for (const prefix of prefixes) {
    const hit = cohort.find((w) =>
      w.wallet.toLowerCase().startsWith(prefix.toLowerCase())
    );
    if (hit) resolved.push(hit.wallet.toLowerCase());
  }
  return resolved;
}

async function walletDurableSnapshot(
  batchId: string,
  wallet: string
): Promise<Record<string, unknown>> {
  const db = getDb();
  const w = wallet.toLowerCase();
  const status = await db
    .select()
    .from(walletShadowBatchStatus)
    .where(
      and(
        eq(walletShadowBatchStatus.batchId, batchId),
        eq(walletShadowBatchStatus.walletAddress, w)
      )
    )
    .limit(1);
  const metrics = await db
    .select()
    .from(walletHistoricalMetrics)
    .where(
      and(
        eq(walletHistoricalMetrics.walletAddress, w),
        eq(walletHistoricalMetrics.metricVersion, WALLET_METRIC_VERSION)
      )
    )
    .limit(1);
  const coverage = await db
    .select()
    .from(walletHistoryCoverage)
    .where(eq(walletHistoryCoverage.walletAddress, w))
    .limit(1);
  const shadow = await db
    .select()
    .from(walletShadowResults)
    .where(
      and(
        eq(walletShadowResults.batchId, batchId),
        eq(walletShadowResults.walletAddress, w)
      )
    )
    .limit(1);
  const eventCount = await db.execute<{ n: number }>(
    sql`select count(*)::int as n from wallet_ledger_events where wallet_address = ${w}`
  );
  const lifecycleCount = await db.execute<{ n: number }>(
    sql`select count(*)::int as n from wallet_position_lifecycles where wallet_address = ${w}`
  );
  const s = status[0];
  const m = metrics[0];
  const structurallyValid =
    s?.status === "complete" &&
    m?.credibilityMetricsValid === true &&
    coverage[0] != null;
  const eligibleFloor10 =
    structurallyValid && (m?.completedPositions ?? 0) >= 10;
  return {
    wallet: w,
    batchStatus: s?.status ?? null,
    errorMessage: s?.errorMessage ?? null,
    deferAttempts: readDeferAttempts(s?.performance),
    updatedAt: s?.updatedAt?.toISOString() ?? null,
    events: eventCount.rows[0]?.n ?? 0,
    lifecycles: lifecycleCount.rows[0]?.n ?? 0,
    coverage: coverage[0]
      ? {
          historyValidity: coverage[0].historyValidity,
          historyComplete: coverage[0].historyComplete,
          lastIndexedBlock: coverage[0].lastIndexedBlock,
        }
      : null,
    metrics: m
      ? {
          completedPositions: m.completedPositions,
          credibilityMetricsValid: m.credibilityMetricsValid,
          historyValidity: m.historyValidity,
        }
      : null,
    shadowResult: shadow[0]
      ? {
          executionStatus: shadow[0].executionStatus,
          credibilityMetricsValid: shadow[0].credibilityMetricsValid,
          updatedAt: shadow[0].updatedAt?.toISOString(),
        }
      : null,
    structurallyValid,
    eligibleFloor10,
    misclassifiedDeferred:
      s?.status === "deferred_infra" && structurallyValid && eligibleFloor10,
  };
}

async function recentPassAYield(batchId: string): Promise<Record<string, unknown>> {
  const db = getDb();
  const rows = await db
    .select()
    .from(walletShadowBatchStatus)
    .where(eq(walletShadowBatchStatus.batchId, batchId))
    .orderBy(desc(walletShadowBatchStatus.updatedAt))
    .limit(300);

  const cohort: Array<{ wallet: string }> = JSON.parse(
    readFileSync(STAGE_C_COHORT_PATH, "utf8")
  ).wallets;
  const cohortSet = new Set(cohort.map((w) => w.wallet.toLowerCase()));

  const attempted = rows.filter(
    (r) =>
      cohortSet.has(r.walletAddress.toLowerCase()) &&
      r.status !== "pending" &&
      classifyMutuallyExclusiveBatchBucket(r) !== "never_attempted"
  );

  const sample = attempted.slice(0, 10);
  const metricsByWallet = new Map<string, number>();
  if (sample.length > 0) {
    const metrics = await db
      .select({
        walletAddress: walletHistoricalMetrics.walletAddress,
        completedPositions: walletHistoricalMetrics.completedPositions,
        credibilityMetricsValid: walletHistoricalMetrics.credibilityMetricsValid,
      })
      .from(walletHistoricalMetrics)
      .where(
        sql`${walletHistoricalMetrics.metricVersion} = ${WALLET_METRIC_VERSION} AND ${walletHistoricalMetrics.walletAddress} IN (${sql.join(
          sample.map((r) => sql`${r.walletAddress.toLowerCase()}`),
          sql`, `
        )})`
      );
    for (const m of metrics) {
      metricsByWallet.set(m.walletAddress.toLowerCase(), m.completedPositions ?? 0);
    }
  }

  let complete = 0;
  let unusable = 0;
  let deferred = 0;
  let eligible = 0;
  let wallMsSum = 0;
  let wallMsN = 0;
  const perWallet: Array<Record<string, unknown>> = [];

  for (const row of sample) {
    const w = row.walletAddress.toLowerCase();
    if (row.status === "complete") complete += 1;
    if (row.status === "unusable") unusable += 1;
    if (row.status === "deferred_infra") deferred += 1;
    const completedPositions = metricsByWallet.get(w) ?? 0;
    if (row.status === "complete" && completedPositions >= 10) eligible += 1;
    const perf = row.performance as { totalMs?: number } | null;
    if (perf?.totalMs != null) {
      wallMsSum += perf.totalMs;
      wallMsN += 1;
    }
    perWallet.push({
      wallet: w,
      status: row.status,
      completedPositions,
      eligibleFloor10: row.status === "complete" && completedPositions >= 10,
      totalMs: perf?.totalMs ?? null,
      updatedAt: row.updatedAt?.toISOString(),
    });
  }

  return {
    sampleSize: sample.length,
    complete,
    eligibleFloor10: eligible,
    unusable,
    deferred_infra: deferred,
    avgWallMs: wallMsN > 0 ? Math.round(wallMsSum / wallMsN) : null,
    perWallet,
    projection: {
      remainingNeverAttempted: 63,
      eligibleRate: sample.length > 0 ? eligible / sample.length : null,
      expectedAdditionalEligible: sample.length > 0
        ? Math.round((eligible / sample.length) * 63)
        : null,
      projectedTotalEligible: sample.length > 0
        ? 47 + Math.round((eligible / sample.length) * 63)
        : null,
    },
  };
}

async function main(): Promise<void> {
  const { finalize } = parseArgs(process.argv.slice(2));
  const batchId = STAGE_C_BATCH_ID;
  const invocationWallets = resolveInvocationWalletsFromLog(LATEST_PASS_A_LOG);

  const journal = readBatchStatusJournal().filter((e) => e.batchId === batchId);
  const journalReconciledAtStart = journal.filter((e) => {
    const ts = Date.parse(e.timestamp);
    return ts >= Date.parse("2026-09-10T07:08:00.000Z") - 60_000 &&
      ts <= Date.parse("2026-09-10T07:08:30.000Z");
  });

  const report = await buildStageCInterimReport({ batchId });
  const invocationSnapshots = await Promise.all(
    invocationWallets.map((w) => walletDurableSnapshot(batchId, w))
  );

  let finalizeResult: unknown = null;
  if (finalize) {
    const journalResult = await reconcileBatchStatusJournal(batchId);
    finalizeResult = { journalResult, note: "Run reconcile-shadow-full50-report separately for reports" };
  }

  const yieldReport = await recentPassAYield(batchId);

  console.log(
    JSON.stringify(
      {
        batchId,
        current: report.batchStatusBuckets,
        eligibleFloor10: report.durableEligibleVerification.eligibleCount,
        invocationWallets,
        invocationWalletSnapshots: invocationSnapshots,
        journalEntriesForBatch: journal.length,
        journalReconciledAtLatestInvocationStart: journalReconciledAtStart.map(
          (e) => ({
            wallet: e.wallet,
            desiredStatus: e.desiredStatus,
            timestamp: e.timestamp,
            errorMessage: e.errorMessage,
          })
        ),
        beforeLatestInvocation: {
          neverAttempted: 66,
          deferred_infra: 29,
          complete: 65,
          unusable: 55,
          source: "phase2e2-stageC-passA-20260910-030800.log line 23 + delta math",
        },
        delta: {
          neverAttempted: report.batchStatusBuckets.never_attempted - 66,
          deferred_infra: report.batchStatusBuckets.deferred_infra - 29,
          complete: report.batchStatusBuckets.complete - 65,
          unusable: report.batchStatusBuckets.unusable - 55,
        },
        recentPassAYield: yieldReport,
        finalizeResult,
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
