#!/usr/bin/env tsx
/**
 * Build Stage C cohort manifest (no audits).
 */
import "./preload-env";
import {
  buildStageCCohort,
  printStageCCohortPreview,
} from "@/lib/walletLedger/indexed/shadow/cohortStageC";

async function main(): Promise<void> {
  const forceRebuild = process.argv.includes("--force-rebuild");
  const manifest = await buildStageCCohort({ forceRebuild });
  printStageCCohortPreview(manifest);
  console.log(
    JSON.stringify(
      {
        manifestPath: "tmp/wallet-history/phase2e2-stageC-cohort.json",
        selected: manifest.composition.selected,
        pass: manifest.composition.pass,
        fail: manifest.composition.fail,
        unknown: manifest.composition.unknown,
        historyStrata: manifest.composition.historyStratumBreakdown,
      },
      null,
      2
    )
  );
}

void main().catch((error) => {
  console.error("[phase2e2-stageC-cohort] failed:", error);
  process.exit(1);
});
