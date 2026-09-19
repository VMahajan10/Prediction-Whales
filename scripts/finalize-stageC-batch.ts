#!/usr/bin/env tsx
/**
 * Idempotent Stage C finalize-only recovery:
 * - journal/status reconciliation
 * - promote misclassified deferred wallets with durable metrics
 * - rebuild wallet_shadow_results from durable state
 * - regenerate batch JSON/MD reports
 *
 * Does NOT run wallet audits or schedule Pass A/B wallets.
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import "./preload-env";
import {
  reconcileBatchStatusJournal,
  reclassifyEnospcBatchStatuses,
  reclassifyInfraFailedBatchStatuses,
} from "@/lib/walletLedger/indexed/shadow/batchStatusJournal";
import {
  loadCohortSpecs,
  observationsToComparisonRows,
  reconcileMisclassifiedDeferredBatchStatuses,
  recoverBatchShadowObservations,
} from "@/lib/walletLedger/indexed/shadow/shadowResultRecovery";
import {
  summarizeShadowBatch,
  writeShadowReports,
} from "@/lib/walletLedger/indexed/shadow/report";
import { buildStageCInterimReport } from "@/lib/walletLedger/indexed/shadow/stageCInterimAnalysis";
import { STAGE_C_BATCH_ID } from "@/lib/walletLedger/indexed/studyVersion";

function parseArgs(argv: string[]): { batchId: string } {
  let batchId = STAGE_C_BATCH_ID;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--batch-id" && argv[i + 1]) {
      batchId = argv[++i]!;
    }
  }
  return { batchId };
}

function backupExisting(path: string): void {
  if (!existsSync(path)) return;
  const backupPath = path.replace(/(\.[^.]+)$/, "-pre-finalize$1");
  if (!existsSync(backupPath)) {
    copyFileSync(path, backupPath);
  }
}

async function main(): Promise<void> {
  const { batchId } = parseArgs(process.argv.slice(2));
  const outDir = join(process.cwd(), "tmp", "wallet-history", "shadow-compare");

  const journal = await reconcileBatchStatusJournal(batchId);
  const infraReclassified = await reclassifyInfraFailedBatchStatuses(batchId);
  const enospcReclassified = await reclassifyEnospcBatchStatuses(batchId);
  const promotedComplete = await reconcileMisclassifiedDeferredBatchStatuses(batchId);

  const cohort = loadCohortSpecs(batchId);
  const observations = await recoverBatchShadowObservations(batchId, {
    persist: true,
  });
  const rows = observationsToComparisonRows(observations);
  const summary = summarizeShadowBatch({
    batchId,
    cohort,
    rows,
    batchComplete: false,
    infraInterrupted: false,
  });

  backupExisting(join(outDir, `shadow-${batchId}.json`));
  backupExisting(join(outDir, `shadow-${batchId}.md`));
  const reportPaths = writeShadowReports({
    batchId,
    rows,
    summary,
    cohort,
  });

  mkdirSync(outDir, { recursive: true });
  const interim = await buildStageCInterimReport({ batchId });

  console.log(
    JSON.stringify(
      {
        batchId,
        mode: "finalize_only",
        journal,
        infraReclassified,
        enospcReclassified,
        promotedComplete,
        observationCount: observations.length,
        reportPaths,
        interim: {
          batchStatusBuckets: interim.batchStatusBuckets,
          eligibleFloor10: interim.durableEligibleVerification.eligibleCount,
        },
      },
      null,
      2
    )
  );
}

void main().catch((error) => {
  console.error("[finalize-stageC-batch] failed:", error);
  process.exit(1);
});
