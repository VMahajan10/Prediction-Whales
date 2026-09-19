#!/usr/bin/env tsx
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import "./preload-env";
import { sql, eq } from "drizzle-orm";
import { getDb } from "@/lib/crossmarket/store/db";
import {
  walletHistoricalMetrics,
  walletHistoryCoverage,
  walletShadowBatchStatus,
} from "@/lib/crossmarket/store/schema";
import {
  performanceVerdictFromPolicy,
  STAGE_C_EXPLORATORY_PERFORMANCE_POLICIES,
} from "@/lib/walletLedger/indexed/credibilityCandidateV2";
import { WALLET_METRIC_VERSION } from "@/lib/walletLedger/indexed/metricVersion";
import { STAGE_C_COHORT_PATH } from "@/lib/walletLedger/indexed/shadow/stageCInterimAnalysis";
import { STAGE_C_BATCH_ID } from "@/lib/walletLedger/indexed/studyVersion";

interface WalletRow {
  wallet: string;
  completedPositions: number;
  realizedRoi: number | null;
  profitablePositionRate: number | null;
}

async function loadEligibleWallets(): Promise<WalletRow[]> {
  const cohort = JSON.parse(readFileSync(STAGE_C_COHORT_PATH, "utf8"));
  const wallets = cohort.wallets.map((w: { wallet: string }) =>
    w.wallet.toLowerCase()
  );
  const db = getDb();
  const statusRows = await db
    .select()
    .from(walletShadowBatchStatus)
    .where(eq(walletShadowBatchStatus.batchId, STAGE_C_BATCH_ID));
  const metricsRows = await db
    .select()
    .from(walletHistoricalMetrics)
    .where(eq(walletHistoricalMetrics.metricVersion, WALLET_METRIC_VERSION));
  const coverageRows = await db.select().from(walletHistoryCoverage);
  const statusBy = new Map(
    statusRows.map((r) => [r.walletAddress.toLowerCase(), r])
  );
  const metricsBy = new Map(
    metricsRows.map((r) => [r.walletAddress.toLowerCase(), r])
  );
  const coverageBy = new Map(
    coverageRows.map((r) => [r.walletAddress.toLowerCase(), r])
  );
  const eligible: WalletRow[] = [];
  for (const wallet of wallets) {
    const status = statusBy.get(wallet);
    const metrics = metricsBy.get(wallet);
    const coverage = coverageBy.get(wallet);
    if (status?.status !== "complete" || !coverage) continue;
    if (!metrics?.credibilityMetricsValid) continue;
    if ((metrics.completedPositions ?? 0) < 10) continue;
    eligible.push({
      wallet,
      completedPositions: metrics.completedPositions,
      realizedRoi: metrics.realizedRoi,
      profitablePositionRate: metrics.profitablePositionRate,
    });
  }
  return eligible;
}

function priorEligibleSet(): Set<string> {
  const priorPath = join(
    process.cwd(),
    "tmp/wallet-history/stageC-calibration-20260909.json"
  );
  const raw = readFileSync(priorPath, "utf8");
  const start = raw.indexOf('{\n  "batchId"');
  const end = raw.lastIndexOf("}");
  const prior = JSON.parse(raw.slice(start, end + 1)) as {
    outliers: Array<{ wallet: string }>;
  };
  const set = new Set<string>();
  for (const o of prior.outliers ?? []) set.add(o.wallet.toLowerCase());
  const shadowPre = join(
    process.cwd(),
    "tmp/wallet-history/shadow-compare/shadow-phase2e2-stageC-v1-pre-finalize.json"
  );
  if (existsSync(shadowPre)) {
    const shadow = JSON.parse(readFileSync(shadowPre, "utf8")) as {
      rows: Array<{ wallet: string; status: string }>;
    };
    for (const row of shadow.rows) {
      if (row.status === "complete") set.add(row.wallet.toLowerCase());
    }
  }
  return set;
}

async function main(): Promise<void> {
  const eligible = await loadEligibleWallets();
  const priorSet = priorEligibleSet();
  const priorWallets = eligible.filter((w) => priorSet.has(w.wallet));
  const newWallets = eligible.filter((w) => !priorSet.has(w.wallet));
  const ref = STAGE_C_EXPLORATORY_PERFORMANCE_POLICIES.find((p) =>
    p.label.includes("ROI > 0 AND profitablePositionRate >= 0.50")
  )!;
  const passes = (w: WalletRow) =>
    performanceVerdictFromPolicy({
      portfolioRealizedRoi: w.realizedRoi,
      profitablePositionRate: w.profitablePositionRate,
      policy: ref,
    }) === "PASS";
  const fullRate = eligible.filter(passes).length / eligible.length;
  const loo = newWallets
    .map((w) => {
      const subset = eligible.filter((x) => x.wallet !== w.wallet);
      const rate = subset.filter(passes).length / subset.length;
      return {
        wallet: w.wallet,
        swingPp: Math.abs(rate - fullRate) * 100,
        passesReference: passes(w),
        completedPositions: w.completedPositions,
        realizedRoi: w.realizedRoi,
        profitablePositionRate: w.profitablePositionRate,
      };
    })
    .sort((a, b) => b.swingPp - a.swingPp);

  console.log(
    JSON.stringify(
      {
        currentN: eligible.length,
        inferredPriorN: priorWallets.length,
        newWallets: loo,
        referencePolicy: ref.label,
        passRate: {
          full: fullRate,
          priorSubset: priorWallets.filter(passes).length / priorWallets.length,
          newSubset: newWallets.filter(passes).length / newWallets.length,
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
