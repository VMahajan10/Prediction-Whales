#!/usr/bin/env tsx
import { readFileSync } from "node:fs";
import "./preload-env";
import { runSingleShadowWallet } from "@/lib/walletLedger/indexed/shadow/batchRunner";
import type { ShadowCohortWallet } from "@/lib/walletLedger/indexed/shadow/cohort";
import { evaluateIndexedProviders } from "@/lib/walletLedger/indexed/pipeline";
import { WORKER_RESULT_PREFIX } from "@/lib/walletLedger/indexed/shadow/invocationSupervisor";
import {
  loadWalletBatchStatus,
  upsertBatchStatusSafe,
} from "@/lib/walletLedger/indexed/shadow/batchStatusJournal";
import { nextDeferPerformance } from "@/lib/walletLedger/indexed/shadow/batchScheduling";
import {
  registerWalletWorkerShutdown,
  type ShutdownReason,
} from "@/lib/walletLedger/indexed/shadow/gracefulShutdown";
import {
  cleanupWorkerResources,
  finishWorkerProcess,
  isInvocationTerminalWalletStatus,
} from "@/lib/walletLedger/indexed/shadow/workerLifecycle";

function parseArgs(argv: string[]): {
  batchId: string;
  walletJsonPath: string;
  fullHistory: boolean;
  enableWalletRuntimeBudget: boolean;
} {
  let batchId = "";
  let walletJsonPath = "";
  let fullHistory = true;
  let enableWalletRuntimeBudget = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--batch-id" && argv[i + 1]) {
      batchId = argv[++i];
    } else if (arg === "--wallet-json" && argv[i + 1]) {
      walletJsonPath = argv[++i];
    } else if (arg === "--full-history") {
      fullHistory = true;
    } else if (arg === "--enable-wallet-runtime-budget") {
      enableWalletRuntimeBudget = true;
    }
  }
  if (!batchId || !walletJsonPath) {
    throw new Error("--batch-id and --wallet-json are required");
  }
  return { batchId, walletJsonPath, fullHistory, enableWalletRuntimeBudget };
}

function emitResult(payload: Record<string, unknown>): void {
  console.log(`${WORKER_RESULT_PREFIX}${JSON.stringify(payload)}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const spec = JSON.parse(
    readFileSync(args.walletJsonPath, "utf8")
  ) as ShadowCohortWallet;

  let shutdownHandled = false;
  const workerShutdownSignal = registerWalletWorkerShutdown({
    onShutdown: async (reason: ShutdownReason) => {
      if (shutdownHandled) return;
      shutdownHandled = true;
      const priorStatus = await loadWalletBatchStatus(args.batchId, spec.wallet);
      if (priorStatus && isInvocationTerminalWalletStatus(priorStatus.status)) {
        emitResult({
          ok: true,
          wallet: spec.wallet,
          status: priorStatus.status,
          shutdownReason: reason,
          preservedTerminalStatus: true,
        });
        await cleanupWorkerResources();
        process.exit(130);
        return;
      }
      const performance = nextDeferPerformance(
        priorStatus,
        { totalMs: 0 },
        true
      );
      await upsertBatchStatusSafe({
        batchId: args.batchId,
        wallet: spec.wallet,
        status: "deferred_infra",
        cohortReason: spec.cohortReason,
        errorMessage: `invocation_worker_shutdown:${reason}`,
        performance,
      });
      emitResult({
        ok: false,
        wallet: spec.wallet,
        status: "deferred_infra",
        shutdownReason: reason,
        error: `invocation_worker_shutdown:${reason}`,
      });
      await cleanupWorkerResources();
      process.exit(130);
    },
  });

  try {
    const providerEvaluations = await evaluateIndexedProviders();
    const row = await runSingleShadowWallet({
      batchId: args.batchId,
      spec,
      providerEvaluations,
      fullHistory: args.fullHistory,
      enableWalletRuntimeBudget: args.enableWalletRuntimeBudget,
      externalAbortSignal: workerShutdownSignal,
    });

    emitResult({
      ok: true,
      wallet: spec.wallet,
      status: row.status,
      row,
    });
    await finishWorkerProcess({ status: row.status, exitCode: 0 });
  } finally {
    await cleanupWorkerResources();
  }
}

void main().catch(async (error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[shadow-wallet-worker] failed: ${message}`);
  emitResult({
    ok: false,
    error: message,
  });
  await cleanupWorkerResources();
  process.exit(1);
});
