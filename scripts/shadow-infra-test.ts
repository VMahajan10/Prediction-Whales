#!/usr/bin/env tsx
/**
 * 3-wallet infrastructure resilience validation (do not run full50).
 */
import "./preload-env";
import { runShadowCredibilityBatch } from "@/lib/walletLedger/indexed/shadow/batchRunner";

const DEFERRED_CANDIDATE = "0xdc41c39b95453c943174f369926018f6963bdd7e";

async function main(): Promise<void> {
  const wallets = [
    {
      wallet: "0xd91e80cf2e7be2e162c6513ced06f1dd0da35296",
      label: "identity_mismatch_probe",
      cohortReason: "infra_test_small",
    },
    {
      wallet: "0x7e5972bfc25819775ee5a9d4f191919375487b8b",
      label: "high_avg_ev_truncated",
      cohortReason: "infra_test_api_truncation",
    },
    {
      wallet: DEFERRED_CANDIDATE,
      label: "legacy50_high_ev",
      cohortReason: "infra_test_deferred_candidate",
    },
  ];

  const result = await runShadowCredibilityBatch({
    batchId: `infra-test-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`,
    stage: "smoke10",
    wallets,
    walletConcurrency: 2,
    fullHistory: true,
    resume: false,
  });

  console.log(
    JSON.stringify(
      {
        batchId: result.batchId,
        summary: {
          batchComplete: result.summary.batchComplete,
          infraInterrupted: result.summary.infraInterrupted,
          complete: result.summary.metricsSafe,
          unusable: result.summary.unusableValidity,
          walletFailed: result.summary.walletFailed,
          deferredInfra: result.summary.deferredInfra,
          pending: result.summary.pending,
        },
        wallets: result.rows.map((row) => ({
          wallet: row.wallet,
          status: row.status,
          error: row.error,
          totalMs: row.performance?.totalMs,
        })),
        reportPaths: result.reportPaths,
      },
      null,
      2
    )
  );
}

void main().catch((error) => {
  console.error("[shadow-infra-test] failed:", error);
  process.exit(1);
});
