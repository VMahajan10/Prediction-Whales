import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  setAuditProgressEnabled,
  EtherscanProgressReporter,
  trackEtherscanProgress,
  stopTrackedEtherscanProgress,
} from "@/lib/walletLedger/indexed/auditProgress";
import {
  cleanupWorkerResources,
  isInvocationTerminalWalletStatus,
} from "@/lib/walletLedger/indexed/shadow/workerLifecycle";
import {
  resolveTsxSpawnCommand,
  superviseChildProcess,
} from "@/lib/walletLedger/indexed/shadow/invocationSupervisor";
import { buildInvocationDeadlinePolicy } from "@/lib/walletLedger/indexed/shadow/invocationLimits";

const TEST_WORKER = join(process.cwd(), "scripts/shadow-supervisor-test-worker.ts");

function superviseDeferTestWorker(mode: string): Promise<{
  stopReason: string;
  wallMs: number;
  forcedKill: boolean;
}> {
  const startedAtMs = Date.now();
  const policy = buildInvocationDeadlinePolicy({
    startedAtMs,
    schedulingMaxRuntimeMs: 60_000,
    perWalletMaxRuntimeMs: 60_000,
    gracefulShutdownMs: 300,
    forceShutdownMs: 200,
  });
  const walletStartedAtMs = Date.now();
  const tsxSpawn = resolveTsxSpawnCommand(TEST_WORKER, []);
  return superviseChildProcess({
    executable: tsxSpawn.executable,
    args: tsxSpawn.args,
    env: { SHADOW_SUPERVISOR_TEST_MODE: mode },
    schedulingDeadlineAtMs: policy.schedulingDeadlineAtMs,
    walletDeadlineAtMs: walletStartedAtMs + 60_000,
    absoluteDeadlineAtMs: startedAtMs + 120_000,
    gracefulShutdownMs: 300,
    forceShutdownMs: 200,
    pollIntervalMs: 50,
  }).then((result) => ({
    stopReason: result.stopReason,
    wallMs: result.wallMs,
    forcedKill: result.forcedKill,
  }));
}

describe("worker defer exit lifecycle", () => {
  afterEach(() => {
    setAuditProgressEnabled(false);
    stopTrackedEtherscanProgress();
    vi.restoreAllMocks();
  });

  it("treats deferred_infra as invocation-terminal", () => {
    expect(isInvocationTerminalWalletStatus("deferred_infra")).toBe(true);
    expect(isInvocationTerminalWalletStatus("running")).toBe(false);
  });

  it("stops orphaned Etherscan progress heartbeat on cleanup", async () => {
    setAuditProgressEnabled(true);
    const reporter = new EtherscanProgressReporter(11);
    trackEtherscanProgress(reporter);
    const stopSpy = vi.spyOn(reporter, "stop");

    await cleanupWorkerResources();

    expect(stopSpy).toHaveBeenCalledTimes(1);
  });

  it("supervised child exits promptly after defer cleanup", async () => {
    const result = await superviseDeferTestWorker("defer_cleanup_exit");
    expect(result.stopReason).toBe("completed");
    expect(result.forcedKill).toBe(false);
    expect(result.wallMs).toBeLessThan(5_000);
  });

  it("orphaned heartbeat keeps child alive until wallet deadline", async () => {
    const started = Date.now();
    const policy = buildInvocationDeadlinePolicy({
      startedAtMs: started,
      schedulingMaxRuntimeMs: 5_000,
      perWalletMaxRuntimeMs: 800,
      gracefulShutdownMs: 100,
      forceShutdownMs: 100,
    });
    const walletStartedAtMs = Date.now();
    const tsxSpawn = resolveTsxSpawnCommand(TEST_WORKER, []);
    const result = await superviseChildProcess({
      executable: tsxSpawn.executable,
      args: tsxSpawn.args,
      env: { SHADOW_SUPERVISOR_TEST_MODE: "defer_orphan_heartbeat" },
      schedulingDeadlineAtMs: policy.schedulingDeadlineAtMs,
      walletDeadlineAtMs: walletStartedAtMs + 800,
      absoluteDeadlineAtMs: started + 10_000,
      gracefulShutdownMs: 100,
      forceShutdownMs: 100,
      pollIntervalMs: 25,
    });
    expect(result.stopReason).toBe("wallet_deadline_graceful");
    expect(result.wallMs).toBeGreaterThanOrEqual(700);
    expect(result.payload?.status).toBe("deferred_infra");
  });
});
