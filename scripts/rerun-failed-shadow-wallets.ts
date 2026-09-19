#!/usr/bin/env tsx
/**
 * Rerun wallets that failed with checkpoint serialization errors.
 */
import "./preload-env";
import { runShadowCredibilityBatch } from "@/lib/walletLedger/indexed/shadow/batchRunner";
import type { ShadowCohortWallet } from "@/lib/walletLedger/indexed/shadow/cohort";

const FAILED_WALLETS: ShadowCohortWallet[] = [
  {
    label: "legacy50_high_ev",
    wallet: "0xdc41c39b95453c943174f369926018f6963bdd7e",
    cohortReason: "checkpoint_rerun_high_volume",
    stratum: "required",
  },
  {
    label: "identity_mismatch_probe",
    wallet: "0xd91e80cf2e7be2e162c6513ced06f1dd0da35296",
    transactionHash:
      "0x59c3aad53bf226ee382efb4b33bbaa4b43563d4298450011e06c9837e891232a",
    cohortReason: "checkpoint_rerun_identity",
    stratum: "required",
  },
];

async function main(): Promise<void> {
  const result = await runShadowCredibilityBatch({
    batchId: `rerun-failed-${Date.now()}`,
    wallets: FAILED_WALLETS,
    walletConcurrency: 1,
    fullHistory: true,
    resume: false,
  });

  for (const row of result.rows) {
    console.log(
      JSON.stringify({
        wallet: row.wallet,
        status: row.status,
        identity: row.evidence,
        indexedEvents: row.evidence.indexedEvents,
        completedPositions: row.evidence.indexedCompletedPositions,
        historyValidity: row.historyValidity,
        credibilityMetricsValid: row.credibilityMetricsValid,
        productionDecision: row.productionDecision,
        apiReconstructedDecision: row.apiReconstructedDecision,
        indexedDecision: row.indexedDecision,
        totalMs: row.performance?.totalMs,
        error: row.error,
      })
    );
  }
  console.log(`\nReport: ${result.reportPaths.mdPath}`);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
