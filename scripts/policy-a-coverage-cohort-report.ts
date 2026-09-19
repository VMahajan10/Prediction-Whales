#!/usr/bin/env tsx
/**
 * Report the rolling 30-day production-wallet Policy A coverage cohort.
 */
import "./preload-env";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { isDatabaseEnabled } from "@/lib/crossmarket/store/db";
import { buildProductionWalletCohort } from "@/lib/walletLedger/indexed/shadow/productionWalletCohort";
import { summarizeCohortCoverage } from "@/lib/walletLedger/indexed/shadow/productionWalletHydration";

const ACTIVE_WALLETS = [
  "0x5268527977f700f9bf9b6d5cd843859e4e70135d",
  "0xfe787d2da716d60e8acff57fb87eb13cd4d10319",
];

async function main(): Promise<void> {
  if (!isDatabaseEnabled()) {
    console.error("DATABASE_URL not configured");
    process.exit(1);
  }

  const cohort = await buildProductionWalletCohort();
  const coverage = summarizeCohortCoverage(cohort.wallets);
  const activeWalletDetails = cohort.wallets.filter((w) =>
    ACTIVE_WALLETS.includes(w.wallet)
  );

  const report = {
    mode: "policy_a_coverage_cohort_report",
    observationPhase: "coverage_shadow",
    minObservationDays: 14,
    cohort,
    coverageSummary: coverage,
    activeFeedWallets: activeWalletDetails,
    activeFeedWalletVerification: activeWalletDetails.map((w) => ({
      wallet: w.wallet,
      feedVisibleTradeCount: w.feedVisibleTradeCount,
      productionPasses: w.passesProductionWalletGate,
      completedPositionsIndexed: w.completedPositions,
      historyValidity: w.historyValidity,
      historyComplete: w.historyComplete,
      hasValidDurableCoverage: w.hasValidDurableCoverage,
      policyADecision: w.policyADecision,
      policyAUnknownReason: w.policyAUnknownReason,
      interpretation:
        w.completedPositions != null && w.completedPositions < 10
          ? "Likely incomplete indexed hydration — only partial positions reconstructed so far"
          : w.hasValidDurableCoverage
            ? "Indexed hydration appears complete for current metric version"
            : "Indexed history present but not yet metrics-valid / complete",
    })),
  };

  const outDir = join(process.cwd(), "tmp/wallet-history");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(
    outDir,
    `policy-a-coverage-cohort-${new Date().toISOString().slice(0, 10)}.json`
  );
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.error(`\n[wrote] ${outPath}`);
}

void main().catch((error) => {
  console.error("[policy-a-coverage-cohort-report] failed:", error);
  process.exit(1);
});
