import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ShadowCohortWallet } from "@/lib/walletLedger/indexed/shadow/cohort";
import {
  InvocationBudget,
  resolveInvocationMaxRuntimeMs,
  resolveInvocationMaxWallets,
} from "@/lib/walletLedger/indexed/shadow/invocationBudget";
import {
  buildInvocationDeadlinePolicy,
  documentedMaxInvocationDurationMs,
  resolveInvocationForceShutdownMs,
  resolveInvocationGracefulShutdownMs,
} from "@/lib/walletLedger/indexed/shadow/invocationLimits";
import {
  buildShadowWalletWorkerArgs,
  resolveShadowWalletWorkerCommand,
  superviseChildProcess,
  summarizeBoundedShutdown,
  walletDeadlinesForStart,
  type BoundedInvocationShutdownSummary,
  type SupervisedWorkerStopReason,
  type SuperviseChildProcessInput,
  type SupervisedWorkerResult,
} from "@/lib/walletLedger/indexed/shadow/invocationSupervisor";
import { loadWalletBatchStatus, upsertBatchStatusSafe } from "@/lib/walletLedger/indexed/shadow/batchStatusJournal";
import {
  nextDeferPerformance,
} from "@/lib/walletLedger/indexed/shadow/batchScheduling";
import type { ShadowWalletComparison } from "@/lib/walletLedger/indexed/shadow/taxonomy";

export type SuperviseChildFn = (
  input: SuperviseChildProcessInput
) => Promise<SupervisedWorkerResult>;

export interface BoundedInvocationOptions {
  batchId: string;
  pending: ShadowCohortWallet[];
  fullHistory: boolean;
  enableWalletRuntimeBudget: boolean;
  invocationMaxWallets?: number;
  invocationMaxRuntimeMs?: number;
  invocationGracefulShutdownMs?: number;
  invocationForceShutdownMs?: number;
  superviseChild?: SuperviseChildFn;
  onForcedParentExit?: () => Promise<void>;
}

export interface BoundedInvocationRunResult {
  rows: ShadowWalletComparison[];
  infraInterrupted: boolean;
  shutdownFailure: boolean;
  invocationBudget: InvocationBudget;
  shutdownSummary?: BoundedInvocationShutdownSummary;
}

function synthesizeInterruptedRow(
  spec: ShadowCohortWallet,
  message: string
): ShadowWalletComparison {
  return {
    wallet: spec.wallet,
    label: spec.label,
    cohortReason: spec.cohortReason,
    productionDecision: null,
    apiReconstructedDecision: null,
    indexedDecision: false,
    productionCredible: null,
    indexedCredible: false,
    productionAgreement: false,
    apiAgreement: false,
    agreement: false,
    primaryReason: "other",
    productionReasons: ["other"],
    apiReasons: ["other"],
    reasons: ["other"],
    evidence: { error: message },
    historyValidity: "unusable",
    historyComplete: false,
    credibilityMetricsValid: false,
    status: "deferred_infra",
    error: message,
  };
}

async function markWalletInvocationInterrupted(
  batchId: string,
  spec: ShadowCohortWallet,
  message: string
): Promise<void> {
  const priorStatus = await loadWalletBatchStatus(batchId, spec.wallet);
  const performance = nextDeferPerformance(
    priorStatus,
    { totalMs: 0 },
    true
  );
  await upsertBatchStatusSafe({
    batchId,
    wallet: spec.wallet,
    status: "deferred_infra",
    cohortReason: spec.cohortReason,
    errorMessage: message,
    performance,
  });
}

export async function runBoundedShadowInvocation(
  options: BoundedInvocationOptions
): Promise<BoundedInvocationRunResult> {
  const invocationBudget = new InvocationBudget(
    resolveInvocationMaxWallets(options.invocationMaxWallets),
    resolveInvocationMaxRuntimeMs(options.invocationMaxRuntimeMs)
  );
  const startedAtMs = invocationBudget.startedAt;
  const policy = buildInvocationDeadlinePolicy({
    startedAtMs,
    schedulingMaxRuntimeMs: invocationBudget.maxRuntimeMs,
    gracefulShutdownMs: resolveInvocationGracefulShutdownMs(
      options.invocationGracefulShutdownMs
    ),
    forceShutdownMs: resolveInvocationForceShutdownMs(
      options.invocationForceShutdownMs
    ),
  });

  console.error(
    `[shadow-batch] boundedInvocation policy=${JSON.stringify({
      schedulingDeadlineMs: policy.schedulingDeadlineAtMs - startedAtMs,
      walletDeadlineMs: policy.perWalletMaxRuntimeMs,
      graceMs: policy.gracefulShutdownMs,
      forceMs: policy.forceShutdownMs,
      absoluteDeadlineMs: documentedMaxInvocationDurationMs(policy),
      schedulingDeadlineAt: new Date(policy.schedulingDeadlineAtMs).toISOString(),
      absoluteDeadlineAt: new Date(policy.absoluteDeadlineAtMs).toISOString(),
      documentedMaxDurationMs: documentedMaxInvocationDurationMs(policy),
    })}`
  );

  const rows: ShadowWalletComparison[] = [];
  const stopReasons: SupervisedWorkerStopReason[] = [];
  let walletsCompleted = 0;
  let forcedKills = 0;
  let shutdownFailure = false;
  let infraInterrupted = false;

  const superviseChild = options.superviseChild ?? superviseChildProcess;
  let activeChildKill: ((signal: NodeJS.Signals) => void) | null = null;
  let activeWalletSpec: ShadowCohortWallet | null = null;

  const documentedMaxMs = documentedMaxInvocationDurationMs(policy);
  let absoluteExitTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    void (async () => {
      console.error(
        `[shadow-batch] absolute invocation deadline exceeded after ${documentedMaxMs}ms — reaping child and forcing parent exit`
      );
      shutdownFailure = true;
      infraInterrupted = true;
      if (activeChildKill) {
        activeChildKill("SIGKILL");
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
      if (activeWalletSpec) {
        await markWalletInvocationInterrupted(
          options.batchId,
          activeWalletSpec,
          "invocation_absolute_parent_deadline"
        );
      }
      if (options.onForcedParentExit) {
        await options.onForcedParentExit();
      }
      process.exit(137);
    })();
  }, documentedMaxMs + 1_000);

  const workerCommand = resolveShadowWalletWorkerCommand();
  const walletJsonDir = join(tmpdir(), "shadow-bounded-invocation");
  mkdirSync(walletJsonDir, { recursive: true });

  for (const spec of options.pending) {
    const now = Date.now();
    if (now >= policy.absoluteDeadlineAtMs) {
      infraInterrupted = true;
      shutdownFailure = true;
      stopReasons.push("absolute_deadline_graceful");
      break;
    }
    if (!invocationBudget.canScheduleNextWallet()) {
      infraInterrupted = true;
      break;
    }

    invocationBudget.markWalletScheduled();
    activeWalletSpec = spec;
    const walletStartedAtMs = Date.now();
    const deadlines = walletDeadlinesForStart(policy, walletStartedAtMs);
    const walletJsonPath = join(
      walletJsonDir,
      `${spec.wallet.toLowerCase()}-${walletStartedAtMs}.json`
    );
    writeFileSync(walletJsonPath, JSON.stringify(spec), "utf8");

    const supervised = await superviseChild({
      executable: workerCommand.executable,
      args: buildShadowWalletWorkerArgs({
        batchId: options.batchId,
        walletJsonPath,
        fullHistory: options.fullHistory,
        enableWalletRuntimeBudget: options.enableWalletRuntimeBudget,
      }),
      schedulingDeadlineAtMs: policy.schedulingDeadlineAtMs,
      walletDeadlineAtMs: deadlines.walletDeadlineAtMs,
      absoluteDeadlineAtMs: deadlines.absoluteDeadlineAtMs,
      gracefulShutdownMs: policy.gracefulShutdownMs,
      forceShutdownMs: policy.forceShutdownMs,
      onRegisterKill: (kill) => {
        activeChildKill = kill;
      },
    });

    activeChildKill = null;
    activeWalletSpec = null;
    stopReasons.push(supervised.stopReason);
    if (supervised.forcedKill) {
      forcedKills += 1;
      shutdownFailure = true;
    }

    const payload = supervised.payload;
    if (payload?.ok && payload.row) {
      walletsCompleted += 1;
      rows.push(payload.row);
      if (!invocationBudget.canScheduleNextWallet()) {
        infraInterrupted = true;
        break;
      }
      continue;
    }

    if (supervised.gracefulShutdownRequested || supervised.forcedKill) {
      infraInterrupted = true;
      const message =
        payload?.error ??
        `invocation_worker_shutdown:${supervised.stopReason}`;
      if (!payload?.status) {
        await markWalletInvocationInterrupted(options.batchId, spec, message);
      }
      rows.push(synthesizeInterruptedRow(spec, message));
      break;
    }

    if (
      payload?.status === "pending" ||
      payload?.status === "deferred_infra"
    ) {
      infraInterrupted = true;
      rows.push(
        synthesizeInterruptedRow(
          spec,
          payload.error ?? `worker_${payload.status ?? "interrupted"}`
        )
      );
      break;
    }

    rows.push(
      synthesizeInterruptedRow(
        spec,
        payload?.error ??
          (supervised.stopReason === "spawn_error"
            ? "worker_spawn_error"
            : `worker_exit_${supervised.exitCode ?? "unknown"}`)
      )
    );
    if (!supervised.ok) {
      infraInterrupted = true;
      break;
    }
  }

  const invocationExhausted = invocationBudget.exhaustedReason();
  if (invocationExhausted || infraInterrupted) {
    infraInterrupted = true;
    console.error(
      `[shadow-batch] invocation budget reached reason=${invocationExhausted ?? "bounded_shutdown"} snapshot=${JSON.stringify(invocationBudget.snapshot())}`
    );
  }

  const shutdownSummary = infraInterrupted
    ? summarizeBoundedShutdown({
        policy,
        startedAtMs,
        walletsStarted: invocationBudget.walletsStarted,
        walletsCompleted,
        stopReasons,
        forcedKills,
        shutdownFailure,
      })
    : undefined;

  if (shutdownSummary) {
    console.error(
      `[shadow-batch] boundedInvocation shutdown=${JSON.stringify(shutdownSummary)}`
    );
  }

  console.error(
    `[shadow-batch] boundedInvocation counters=${JSON.stringify({
      walletsActuallyStarted: invocationBudget.walletsStarted,
      walletsFinished: walletsCompleted,
    })}`
  );

  if (absoluteExitTimer) {
    clearTimeout(absoluteExitTimer);
    absoluteExitTimer = null;
  }

  return {
    rows,
    infraInterrupted,
    shutdownFailure,
    invocationBudget,
    shutdownSummary,
  };
}
