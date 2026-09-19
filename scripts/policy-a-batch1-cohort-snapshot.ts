#!/usr/bin/env tsx
/**
 * Post-Batch-1 cohort snapshot + Batch-1 hydration/policyA verification from durable DB state.
 */
import "./preload-env";
import {
  writeFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { eq, inArray, sql } from "drizzle-orm";
import { getDb, isDatabaseEnabled } from "@/lib/crossmarket/store/db";
import {
  policyAProductionWalletHydration,
  walletHistoricalMetrics,
  walletHistoryCoverage,
} from "@/lib/crossmarket/store/schema";
import { buildProductionWalletCohort } from "@/lib/walletLedger/indexed/shadow/productionWalletCohort";
import { summarizeCohortCoverage } from "@/lib/walletLedger/indexed/shadow/productionWalletHydration";
import { WALLET_METRIC_VERSION } from "@/lib/walletLedger/indexed/metricVersion";
import type { WalletValidationSnapshot } from "@/lib/walletLedger/indexed/store/validationSnapshot";

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

async function main(): Promise<void> {
  if (!isDatabaseEnabled()) {
    console.error("DATABASE_URL not configured");
    process.exit(1);
  }
  const db = getDb();
  const generatedAt = new Date().toISOString();

  const cohort = await buildProductionWalletCohort();
  const coverageSummary = summarizeCohortCoverage(cohort.wallets);

  const batch1Metrics = await db
    .select()
    .from(walletHistoricalMetrics)
    .where(
      inArray(
        walletHistoricalMetrics.walletAddress,
        BATCH1_WALLETS.map((w) => w.toLowerCase())
      )
    );

  const batch1Coverage = await db
    .select()
    .from(walletHistoryCoverage)
    .where(
      inArray(
        walletHistoryCoverage.walletAddress,
        BATCH1_WALLETS.map((w) => w.toLowerCase())
      )
    );

  const batch1Hydration = await db
    .select()
    .from(policyAProductionWalletHydration)
    .where(
      inArray(
        policyAProductionWalletHydration.walletAddress,
        BATCH1_WALLETS.map((w) => w.toLowerCase())
      )
    );

  const snapshotDir = join(process.cwd(), ".cache", "wallet-validation-snapshots");
  const snapshotFiles = existsSync(snapshotDir) ? readdirSync(snapshotDir) : [];

  function loadLatestValidationSnapshot(
    wallet: string
  ): WalletValidationSnapshot | null {
    const prefix = wallet.toLowerCase();
    const match = snapshotFiles
      .filter((file) => file.startsWith(prefix))
      .sort()
      .at(-1);
    if (!match) return null;
    return JSON.parse(
      readFileSync(join(snapshotDir, match), "utf8")
    ) as WalletValidationSnapshot;
  }

  const batch1FromDb = BATCH1_WALLETS.map((wallet) => {
    const normalized = wallet.toLowerCase();
    const metrics = batch1Metrics.find(
      (row) => row.walletAddress.toLowerCase() === normalized
    );
    const coverage = batch1Coverage.find(
      (row) => row.walletAddress.toLowerCase() === normalized
    );
    const hydration = batch1Hydration.find(
      (row) => row.walletAddress.toLowerCase() === normalized
    );
    const cohortMember = cohort.wallets.find(
      (row) => row.wallet.toLowerCase() === normalized
    );
    const snapshot = loadLatestValidationSnapshot(wallet);

    const policyAVerdict =
      snapshot?.auditMetrics.policyAVerdict ??
      cohortMember?.policyADecision ??
      hydration?.policyADecision ??
      "UNKNOWN";

    const hydrationGate =
      coverage?.identityComplete === true &&
      coverage?.eventHistoryComplete === true
        ? "PASS"
        : snapshot != null
          ? "PASS"
          : coverage
            ? "FAIL"
            : "UNKNOWN";

    return {
      wallet,
      short: `${wallet.slice(0, 6)}`,
      hydrationGate,
      policyAVerdict,
      policyAUnknownReason: cohortMember?.policyAUnknownReason ?? null,
      completedPositions:
        snapshot?.auditMetrics.completedPositions ??
        metrics?.completedPositions ??
        hydration?.completedPositions ??
        null,
      realizedRoi:
        snapshot?.auditMetrics.realizedRoi ?? metrics?.realizedRoi ?? null,
      profitablePositionRate:
        snapshot?.auditMetrics.profitablePositionRate ??
        metrics?.profitablePositionRate ??
        null,
      historyValidity:
        snapshot?.auditMetrics.historyValidity ??
        coverage?.historyValidity ??
        hydration?.historyValidity ??
        null,
      identityComplete: coverage?.identityComplete ?? null,
      eventHistoryComplete: coverage?.eventHistoryComplete ?? null,
      hasValidDurableCoverage: cohortMember?.hasValidDurableCoverage ?? null,
      metricVersion: metrics?.metricVersion ?? snapshot?.metricVersion ?? null,
      expectedMetricVersion: WALLET_METRIC_VERSION,
      validationSnapshot: snapshot
        ? snapshotFiles.filter((f) => f.startsWith(normalized)).sort().at(-1)
        : null,
    };
  });

  const unknownBreakdown: Record<string, number> = {};
  for (const member of cohort.wallets) {
    if (member.policyADecision !== "UNKNOWN") continue;
    const reason = member.policyAUnknownReason ?? "unspecified";
    unknownBreakdown[reason] = (unknownBreakdown[reason] ?? 0) + 1;
  }

  const evaluable = cohort.wallets.filter(
    (m) => m.policyADecision === "PASS" || m.policyADecision === "FAIL"
  ).length;

  const outDir = join(process.cwd(), ".cache");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `policy-a-cohort-snapshot-${generatedAt.slice(0, 10)}.json`);

  let priorSnapshot: Record<string, unknown> | null = null;
  const priorCandidates = [
    join(outDir, "policy-a-determinism-gate-final.json"),
    join(process.cwd(), "tmp/wallet-history/policy-a-coverage-cohort-2026-03-15.json"),
  ];
  for (const path of priorCandidates) {
    if (existsSync(path)) {
      try {
        priorSnapshot = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
        break;
      } catch {
        // continue
      }
    }
  }

  const report = {
    mode: "policy_a_post_batch1_cohort_snapshot",
    generatedAt,
    cohort: {
      lookbackDays: cohort.lookbackDays,
      totalWallets: cohort.totalWallets,
      policyAPass: cohort.policyAPass,
      policyAFail: cohort.policyAFail,
      policyAUnknown: cohort.policyAUnknown,
      evaluablePct: cohort.totalWallets > 0 ? (evaluable / cohort.totalWallets) * 100 : 0,
      validDurableCoveragePct:
        cohort.totalWallets > 0
          ? (coverageSummary.withValidDurableCoverage / cohort.totalWallets) * 100
          : 0,
      unknownReasonBreakdown: unknownBreakdown,
    },
    batch1: batch1FromDb,
    priorSnapshotComparison: priorSnapshot
      ? {
          source: "best_available_prior",
          priorTotalWallets:
            (priorSnapshot.cohort as { totalWallets?: number })?.totalWallets ??
            (priorSnapshot as { totalWallets?: number }).totalWallets ??
            null,
          note:
            "Rolling 30-day membership churn may shift totals; compare verdict mix not raw counts only.",
        }
      : null,
  };

  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.error(`\n[wrote] ${outPath}`);
}

void main().catch((error) => {
  console.error("[policy-a-batch1-cohort-snapshot] failed:", error);
  process.exit(1);
});
