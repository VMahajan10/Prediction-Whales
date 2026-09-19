import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildInvocationDeadlinePolicy,
  DEFAULT_INVOCATION_FORCE_SHUTDOWN_MS,
  DEFAULT_INVOCATION_GRACEFUL_SHUTDOWN_MS,
  DEFAULT_INVOCATION_SCHEDULING_MS,
  documentedMaxInvocationDurationMs,
} from "@/lib/walletLedger/indexed/shadow/invocationLimits";
import { writeFileSync } from "node:fs";
import {
  acquireStageCInvocationLock,
  releaseStageCInvocationLock,
  STAGE_C_INVOCATION_LOCK_FILE,
  StageCInvocationLockError,
} from "@/lib/walletLedger/indexed/shadow/invocationLock";
import {
  resolveTsxSpawnCommand,
  superviseChildProcess,
} from "@/lib/walletLedger/indexed/shadow/invocationSupervisor";
import { resolveEtherscanWalletMaxRuntimeMs } from "@/lib/walletLedger/indexed/etherscanErrors";

const TEST_WORKER = join(process.cwd(), "scripts/shadow-supervisor-test-worker.ts");

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function superviseTestWorker(input: {
  mode: string;
  schedulingMs: number;
  walletMs: number;
  gracefulMs: number;
  forceMs: number;
  absoluteExtraMs?: number;
}) {
  const startedAtMs = Date.now();
  const policy = buildInvocationDeadlinePolicy({
    startedAtMs,
    schedulingMaxRuntimeMs: input.schedulingMs,
    perWalletMaxRuntimeMs: input.walletMs,
    gracefulShutdownMs: input.gracefulMs,
    forceShutdownMs: input.forceMs,
  });
  const walletStartedAtMs = Date.now();
  const tsxSpawn = resolveTsxSpawnCommand(TEST_WORKER, []);
  return superviseChildProcess({
    executable: tsxSpawn.executable,
    args: tsxSpawn.args,
    env: { SHADOW_SUPERVISOR_TEST_MODE: input.mode },
    schedulingDeadlineAtMs: policy.schedulingDeadlineAtMs,
    walletDeadlineAtMs: walletStartedAtMs + input.walletMs,
    absoluteDeadlineAtMs:
      startedAtMs +
      (input.absoluteExtraMs ??
        documentedMaxInvocationDurationMs(policy)),
    gracefulShutdownMs: input.gracefulMs,
    forceShutdownMs: input.forceMs,
    pollIntervalMs: 50,
  });
}

describe("invocation deadline policy", () => {
  it("documents absolute deadline as scheduling + wallet + grace + force", () => {
    const startedAtMs = 1_000;
    const policy = buildInvocationDeadlinePolicy({
      startedAtMs,
      schedulingMaxRuntimeMs: 2_000,
      perWalletMaxRuntimeMs: 3_000,
      gracefulShutdownMs: 400,
      forceShutdownMs: 100,
    });
    expect(policy.schedulingDeadlineAtMs).toBe(3_000);
    expect(policy.absoluteDeadlineAtMs).toBe(6_500);
    expect(documentedMaxInvocationDurationMs(policy)).toBe(5_500);
  });

  it("defaults to 3h 2m 30s documented max (2h scheduling + 60m wallet + 2m grace + 30s force)", () => {
    const startedAtMs = 0;
    const perWalletMaxRuntimeMs = resolveEtherscanWalletMaxRuntimeMs();
    const policy = buildInvocationDeadlinePolicy({
      startedAtMs,
      schedulingMaxRuntimeMs: DEFAULT_INVOCATION_SCHEDULING_MS,
      perWalletMaxRuntimeMs,
      gracefulShutdownMs: DEFAULT_INVOCATION_GRACEFUL_SHUTDOWN_MS,
      forceShutdownMs: DEFAULT_INVOCATION_FORCE_SHUTDOWN_MS,
    });
    const threeHoursTwoMinutesThirtySecondsMs =
      3 * 60 * 60 * 1000 + 2 * 60 * 1000 + 30 * 1000;
    expect(documentedMaxInvocationDurationMs(policy)).toBe(
      threeHoursTwoMinutesThirtySecondsMs
    );
    expect(policy.absoluteDeadlineAtMs).toBe(
      startedAtMs + threeHoursTwoMinutesThirtySecondsMs
    );
  });
});

describe("invocation supervisor", () => {
  it("completes fast workers normally", async () => {
    const result = await superviseTestWorker({
      mode: "complete_fast",
      schedulingMs: 5_000,
      walletMs: 5_000,
      gracefulMs: 500,
      forceMs: 200,
    });
    expect(result.ok).toBe(true);
    expect(result.stopReason).toBe("completed");
    expect(result.payload?.ok).toBe(true);
    expect(result.forcedKill).toBe(false);
  });

  it("terminates a non-cooperative worker after grace and force windows", async () => {
    const schedulingMs = 1_200;
    const gracefulMs = 300;
    const forceMs = 200;
    const result = await superviseTestWorker({
      mode: "ignore_signal",
      schedulingMs,
      walletMs: 8_000,
      gracefulMs,
      forceMs,
      absoluteExtraMs: 5_000,
    });

    expect(result.stderr).toContain("[test-worker] ignore_signal alive");
    expect(result.gracefulShutdownRequested).toBe(true);
    expect(result.stderr).toContain("[test-worker] ignoring SIGTERM");
    expect(result.forcedKill).toBe(true);
    expect(result.stopReason).toBe("forced_sigkill");
    expect(result.wallMs).toBeGreaterThanOrEqual(schedulingMs + gracefulMs - 150);
    expect(result.wallMs).toBeLessThan(schedulingMs + gracefulMs + forceMs + 1_500);
    if (result.childPid != null) {
      expect(isProcessAlive(result.childPid)).toBe(false);
    }
  });

  it("terminates hang_forever worker at scheduling deadline", async () => {
    const result = await superviseTestWorker({
      mode: "hang_forever",
      schedulingMs: 250,
      walletMs: 10_000,
      gracefulMs: 200,
      forceMs: 150,
      absoluteExtraMs: 1_500,
    });
    expect(result.gracefulShutdownRequested).toBe(true);
    expect(result.wallMs).toBeLessThan(1_500);
  });

  it("terminates block_persist worker within absolute deadline", async () => {
    const result = await superviseTestWorker({
      mode: "block_persist",
      schedulingMs: 300,
      walletMs: 10_000,
      gracefulMs: 250,
      forceMs: 200,
      absoluteExtraMs: 2_000,
    });
    expect(result.gracefulShutdownRequested).toBe(true);
    expect(result.wallMs).toBeLessThan(2_000);
  });

  it("SIGKILLs a sync event-loop-starved child at wallet deadline + grace", async () => {
    const walletMs = 1_000;
    const gracefulMs = 500;
    const forceMs = 500;
    const started = Date.now();
    const result = await superviseTestWorker({
      mode: "block_event_loop",
      schedulingMs: 60_000,
      walletMs,
      gracefulMs,
      forceMs,
      absoluteExtraMs: 10_000,
    });

    expect(result.stderr).toContain("[test-worker] block_event_loop alive");
    expect(result.gracefulShutdownRequested).toBe(true);
    expect(result.stopReason).toBe("forced_sigkill");
    expect(result.forcedKill).toBe(true);
    expect(result.wallMs).toBeGreaterThanOrEqual(walletMs + gracefulMs - 150);
    expect(result.wallMs).toBeLessThan(walletMs + gracefulMs + forceMs + 1_500);
    expect(Date.now() - started).toBeLessThan(walletMs + gracefulMs + forceMs + 2_000);
    if (result.childPid != null) {
      expect(isProcessAlive(result.childPid)).toBe(false);
    }
  });

  it("enforces wallet budget for exceed_wallet_budget mode", async () => {
    const result = await superviseTestWorker({
      mode: "exceed_wallet_budget",
      schedulingMs: 10_000,
      walletMs: 300,
      gracefulMs: 150,
      forceMs: 100,
      absoluteExtraMs: 1_200,
    });
    expect(result.gracefulShutdownRequested).toBe(true);
    expect(result.wallMs).toBeLessThan(1_000);
  });
});

describe("stage C invocation lock", () => {
  it("prevents overlapping lock holders in-process", () => {
    acquireStageCInvocationLock("phase2e2-stageC-v1");
    expect(() => acquireStageCInvocationLock("phase2e2-stageC-v1")).toThrow(
      StageCInvocationLockError
    );
    releaseStageCInvocationLock();
    acquireStageCInvocationLock("phase2e2-stageC-v1");
    releaseStageCInvocationLock();
  });

  it("recovers stale lock files when the recorded pid is not alive", () => {
    writeFileSync(
      STAGE_C_INVOCATION_LOCK_FILE,
      JSON.stringify({
        pid: 9_999_999,
        batchId: "stale-lock-test",
        startedAt: new Date(0).toISOString(),
      }),
      "utf8"
    );
    acquireStageCInvocationLock("phase2e2-stageC-v1");
    releaseStageCInvocationLock();
  });
});
