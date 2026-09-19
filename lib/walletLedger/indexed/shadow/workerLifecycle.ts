import { stopTrackedEtherscanProgress } from "@/lib/walletLedger/indexed/auditProgress";
import { stopEventLoopDelayMonitor } from "@/lib/walletLedger/indexed/eventLoopMonitor";

const INVOCATION_TERMINAL_WALLET_STATUSES = new Set([
  "complete",
  "unusable",
  "wallet_failed",
  "internal_error",
  "deferred_infra",
]);

export function isInvocationTerminalWalletStatus(status: string): boolean {
  return INVOCATION_TERMINAL_WALLET_STATUSES.has(status);
}

/** Release worker-owned timers and progress reporters so the child can exit promptly. */
export async function cleanupWorkerResources(): Promise<void> {
  stopTrackedEtherscanProgress();
  stopEventLoopDelayMonitor();
}

/**
 * After a single-wallet worker finishes bookkeeping, exit without waiting for the
 * parent wallet deadline. Non-zero exit codes are reserved for unexpected failures.
 */
export async function finishWorkerProcess(input: {
  status: string;
  exitCode?: number;
}): Promise<void> {
  await cleanupWorkerResources();
  if (!isInvocationTerminalWalletStatus(input.status)) {
    return;
  }
  process.exit(input.exitCode ?? 0);
}
