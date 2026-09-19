import { spawn } from "node:child_process";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
import type { InvocationDeadlinePolicy } from "@/lib/walletLedger/indexed/shadow/invocationLimits";
import type { ShadowWalletComparison } from "@/lib/walletLedger/indexed/shadow/taxonomy";

export const WORKER_RESULT_PREFIX = "WORKER_RESULT:";

export type SupervisedWorkerStopReason =
  | "completed"
  | "worker_exit_nonzero"
  | "scheduling_deadline_graceful"
  | "wallet_deadline_graceful"
  | "absolute_deadline_graceful"
  | "forced_sigkill"
  | "spawn_error";

export interface SupervisedWorkerPayload {
  ok: boolean;
  status?: string;
  wallet?: string;
  error?: string;
  shutdownReason?: string;
  row?: ShadowWalletComparison;
}

export interface SupervisedWorkerResult {
  ok: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stopReason: SupervisedWorkerStopReason;
  payload: SupervisedWorkerPayload | null;
  wallMs: number;
  stdout: string;
  stderr: string;
  gracefulShutdownRequested: boolean;
  forcedKill: boolean;
  childPid: number | null;
}

export interface SuperviseChildProcessInput {
  executable: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
  schedulingDeadlineAtMs: number;
  walletDeadlineAtMs: number;
  absoluteDeadlineAtMs: number;
  gracefulShutdownMs: number;
  forceShutdownMs: number;
  pollIntervalMs?: number;
  onRegisterKill?: (kill: (signal: NodeJS.Signals) => void) => void;
}

function isChildProcessAlive(child: {
  pid?: number | null;
  exitCode: number | null;
}): boolean {
  if (child.exitCode != null) return false;
  if (child.pid == null) return false;
  try {
    process.kill(child.pid, 0);
    return true;
  } catch {
    return false;
  }
}

function parseWorkerPayload(stdout: string): SupervisedWorkerPayload | null {
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!;
    if (!line.startsWith(WORKER_RESULT_PREFIX)) continue;
    try {
      return JSON.parse(line.slice(WORKER_RESULT_PREFIX.length)) as SupervisedWorkerPayload;
    } catch {
      return null;
    }
  }
  return null;
}

export async function superviseChildProcess(
  input: SuperviseChildProcessInput
): Promise<SupervisedWorkerResult> {
  const started = Date.now();
  const pollIntervalMs = input.pollIntervalMs ?? 250;
  let stdout = "";
  let stderr = "";
  let gracefulShutdownRequested = false;
  let forcedKill = false;
  let stopReason: SupervisedWorkerStopReason = "completed";
  let gracefulTimer: ReturnType<typeof setTimeout> | null = null;
  let forceTimer: ReturnType<typeof setTimeout> | null = null;

  const child = spawn(input.executable, input.args, {
    cwd: input.cwd ?? process.cwd(),
    env: { ...process.env, ...input.env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });

  const signalChild = (signal: NodeJS.Signals) => {
    if (child.pid == null) return;
    if (process.platform === "win32") {
      child.kill(signal);
      return;
    }
    try {
      process.kill(-child.pid, signal);
    } catch {
      child.kill(signal);
    }
  };
  input.onRegisterKill?.(signalChild);

  child.stdout?.on("data", (chunk: Buffer | string) => {
    const text = String(chunk);
    stdout += text;
  });
  child.stderr?.on("data", (chunk: Buffer | string) => {
    const text = String(chunk);
    stderr += text;
    process.stderr.write(text);
  });

  const requestGracefulShutdown = (reason: SupervisedWorkerStopReason) => {
    if (gracefulShutdownRequested || !isChildProcessAlive(child)) {
      return;
    }
    gracefulShutdownRequested = true;
    stopReason = reason;
    signalChild("SIGTERM");
    if (gracefulTimer) clearTimeout(gracefulTimer);
    if (forceTimer) clearTimeout(forceTimer);
    gracefulTimer = setTimeout(() => {
      if (!isChildProcessAlive(child)) return;
      forcedKill = true;
      stopReason = "forced_sigkill";
      signalChild("SIGKILL");
      forceTimer = setTimeout(() => {
        if (!isChildProcessAlive(child)) return;
        signalChild("SIGKILL");
      }, input.forceShutdownMs);
    }, input.gracefulShutdownMs);
  };

  const monitor = setInterval(() => {
    if (!isChildProcessAlive(child)) return;
    const now = Date.now();
    if (now >= input.absoluteDeadlineAtMs) {
      requestGracefulShutdown("absolute_deadline_graceful");
      return;
    }
    if (now >= input.walletDeadlineAtMs) {
      requestGracefulShutdown("wallet_deadline_graceful");
      return;
    }
    if (now >= input.schedulingDeadlineAtMs) {
      requestGracefulShutdown("scheduling_deadline_graceful");
    }
  }, pollIntervalMs);

  const hardExitDeadlineMs =
    input.absoluteDeadlineAtMs + input.forceShutdownMs + 5_000;
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      const hardTimer = setTimeout(() => {
        if (!isChildProcessAlive(child)) return;
        if (!gracefulShutdownRequested) {
          requestGracefulShutdown("absolute_deadline_graceful");
        }
        if (!forcedKill && isChildProcessAlive(child)) {
          forcedKill = true;
          stopReason = "forced_sigkill";
          signalChild("SIGKILL");
        }
        resolve({ code: null, signal: "SIGKILL" });
      }, Math.max(1_000, hardExitDeadlineMs - Date.now()));

      child.on("error", (error) => {
        clearTimeout(hardTimer);
        reject(error);
      });
      child.on("close", (code, signal) => {
        clearTimeout(hardTimer);
        resolve({ code, signal });
      });
    }
  ).catch((error) => {
    clearInterval(monitor);
    if (gracefulTimer) clearTimeout(gracefulTimer);
    if (forceTimer) clearTimeout(forceTimer);
    return {
      error,
      code: null as number | null,
      signal: null as NodeJS.Signals | null,
    };
  });

  clearInterval(monitor);
  if (gracefulTimer) clearTimeout(gracefulTimer);
  if (forceTimer) clearTimeout(forceTimer);

  if ("error" in exit && exit.error) {
    return {
      ok: false,
      exitCode: null,
      signal: null,
      stopReason: "spawn_error",
      payload: null,
      wallMs: Date.now() - started,
      stdout,
      stderr: `${stderr}\n${String(exit.error)}`,
      gracefulShutdownRequested,
      forcedKill,
      childPid: child.pid ?? null,
    };
  }

  const payload = parseWorkerPayload(stdout);
  const code = exit.code;
  const signal = exit.signal;

  if (!gracefulShutdownRequested) {
    stopReason = code === 0 ? "completed" : "worker_exit_nonzero";
  } else if (!forcedKill && code === 0) {
    stopReason = stopReason === "completed" ? "completed" : stopReason;
  }

  return {
    ok: code === 0 && payload?.ok === true,
    exitCode: code,
    signal,
    stopReason,
    payload,
    wallMs: Date.now() - started,
    stdout,
    stderr,
    gracefulShutdownRequested,
    forcedKill,
    childPid: child.pid ?? null,
  };
}

export function resolveTsxSpawnCommand(scriptPath: string, args: string[] = []): {
  executable: string;
  args: string[];
} {
  const tsxEntry = require.resolve("tsx");
  return {
    executable: process.execPath,
    args: ["--import", tsxEntry, scriptPath, ...args],
  };
}

export function resolveShadowWalletWorkerCommand(): {
  executable: string;
  scriptPath: string;
} {
  const scriptPath = join(
    process.cwd(),
    "scripts",
    "shadow-credibility-compare-wallet-worker.ts"
  );
  return {
    executable: process.execPath,
    scriptPath,
  };
}

export function buildShadowWalletWorkerArgs(input: {
  batchId: string;
  walletJsonPath: string;
  fullHistory: boolean;
  enableWalletRuntimeBudget: boolean;
}): string[] {
  const { scriptPath } = resolveShadowWalletWorkerCommand();
  const workerArgs = [
    "--batch-id",
    input.batchId,
    "--wallet-json",
    input.walletJsonPath,
    ...(input.fullHistory ? ["--full-history"] : []),
    ...(input.enableWalletRuntimeBudget ? ["--enable-wallet-runtime-budget"] : []),
  ];
  return resolveTsxSpawnCommand(scriptPath, workerArgs).args;
}

export function walletDeadlinesForStart(
  policy: InvocationDeadlinePolicy,
  walletStartedAtMs: number
): {
  walletDeadlineAtMs: number;
  absoluteDeadlineAtMs: number;
} {
  const walletDeadlineAtMs = Math.min(
    walletStartedAtMs + policy.perWalletMaxRuntimeMs,
    policy.absoluteDeadlineAtMs
  );
  return {
    walletDeadlineAtMs,
    absoluteDeadlineAtMs: policy.absoluteDeadlineAtMs,
  };
}

export interface BoundedInvocationShutdownSummary {
  infraInterrupted: boolean;
  shutdownFailure: boolean;
  stopReasons: SupervisedWorkerStopReason[];
  walletsStarted: number;
  walletsCompleted: number;
  forcedKills: number;
  wallMs: number;
  policy: InvocationDeadlinePolicy;
}

export function summarizeBoundedShutdown(
  input: {
    policy: InvocationDeadlinePolicy;
    startedAtMs: number;
    walletsStarted: number;
    walletsCompleted: number;
    stopReasons: SupervisedWorkerStopReason[];
    forcedKills: number;
    shutdownFailure: boolean;
  }
): BoundedInvocationShutdownSummary {
  return {
    infraInterrupted: true,
    shutdownFailure: input.shutdownFailure,
    stopReasons: input.stopReasons,
    walletsStarted: input.walletsStarted,
    walletsCompleted: input.walletsCompleted,
    forcedKills: input.forcedKills,
    wallMs: Date.now() - input.startedAtMs,
    policy: input.policy,
  };
}
