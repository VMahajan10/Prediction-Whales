import { resolveEtherscanWalletMaxRuntimeMs } from "@/lib/walletLedger/indexed/etherscanErrors";

/** Stop scheduling new wallets after invocationStart + maxRuntimeMs. */
export const DEFAULT_INVOCATION_SCHEDULING_MS = 2 * 60 * 60 * 1000;

/** Cooperative SIGTERM window for atomic DB work after a deadline breach. */
export const DEFAULT_INVOCATION_GRACEFUL_SHUTDOWN_MS = 120_000;

/** Forced SIGKILL window after graceful shutdown was requested. */
export const DEFAULT_INVOCATION_FORCE_SHUTDOWN_MS = 30_000;

export function resolveInvocationGracefulShutdownMs(
  override?: number
): number {
  if (override != null && Number.isFinite(override) && override >= 0) {
    return Math.floor(override);
  }
  const raw = process.env.STAGE_C_INVOCATION_GRACEFUL_SHUTDOWN_MS?.trim();
  if (!raw) return DEFAULT_INVOCATION_GRACEFUL_SHUTDOWN_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_INVOCATION_GRACEFUL_SHUTDOWN_MS;
  }
  return Math.floor(parsed);
}

export function resolveInvocationForceShutdownMs(override?: number): number {
  if (override != null && Number.isFinite(override) && override >= 0) {
    return Math.floor(override);
  }
  const raw = process.env.STAGE_C_INVOCATION_FORCE_SHUTDOWN_MS?.trim();
  if (!raw) return DEFAULT_INVOCATION_FORCE_SHUTDOWN_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_INVOCATION_FORCE_SHUTDOWN_MS;
  }
  return Math.floor(parsed);
}

export interface InvocationDeadlinePolicy {
  startedAtMs: number;
  /** No new wallets may start after this instant. */
  schedulingDeadlineAtMs: number;
  /** Per-wallet execution budget (Etherscan + persistence in worker). */
  perWalletMaxRuntimeMs: number;
  /** SIGTERM cooperative window after an active wallet breaches a deadline. */
  gracefulShutdownMs: number;
  /** SIGKILL window after SIGTERM if the worker is still alive. */
  forceShutdownMs: number;
  /**
   * Hard wall-clock cap for the entire invocation:
   * scheduling + one active wallet + graceful + force.
   */
  absoluteDeadlineAtMs: number;
}

export function buildInvocationDeadlinePolicy(input: {
  startedAtMs: number;
  schedulingMaxRuntimeMs: number | null;
  perWalletMaxRuntimeMs?: number;
  gracefulShutdownMs?: number;
  forceShutdownMs?: number;
}): InvocationDeadlinePolicy {
  const perWalletMaxRuntimeMs =
    input.perWalletMaxRuntimeMs ?? resolveEtherscanWalletMaxRuntimeMs();
  const gracefulShutdownMs = resolveInvocationGracefulShutdownMs(
    input.gracefulShutdownMs
  );
  const forceShutdownMs = resolveInvocationForceShutdownMs(input.forceShutdownMs);
  const schedulingSpanMs =
    input.schedulingMaxRuntimeMs ?? DEFAULT_INVOCATION_SCHEDULING_MS;
  const schedulingDeadlineAtMs = input.startedAtMs + schedulingSpanMs;
  const absoluteDeadlineAtMs =
    schedulingDeadlineAtMs +
    perWalletMaxRuntimeMs +
    gracefulShutdownMs +
    forceShutdownMs;

  return {
    startedAtMs: input.startedAtMs,
    schedulingDeadlineAtMs,
    perWalletMaxRuntimeMs,
    gracefulShutdownMs,
    forceShutdownMs,
    absoluteDeadlineAtMs,
  };
}

export function documentedMaxInvocationDurationMs(policy: InvocationDeadlinePolicy): number {
  return policy.absoluteDeadlineAtMs - policy.startedAtMs;
}

export function describeBoundedInvocationStartup(input: {
  startedAtMs: number;
  schedulingMaxRuntimeMs: number | null;
  perWalletMaxRuntimeMs?: number;
  gracefulShutdownMs?: number;
  forceShutdownMs?: number;
  supervised: boolean;
}): {
  supervised: boolean;
  schedulingDeadlineMs: number;
  walletDeadlineMs: number;
  graceMs: number;
  forceMs: number;
  absoluteDeadlineMs: number;
} {
  const policy = buildInvocationDeadlinePolicy({
    startedAtMs: input.startedAtMs,
    schedulingMaxRuntimeMs: input.schedulingMaxRuntimeMs,
    perWalletMaxRuntimeMs: input.perWalletMaxRuntimeMs,
    gracefulShutdownMs: input.gracefulShutdownMs,
    forceShutdownMs: input.forceShutdownMs,
  });
  return {
    supervised: input.supervised,
    schedulingDeadlineMs: policy.schedulingDeadlineAtMs - input.startedAtMs,
    walletDeadlineMs: policy.perWalletMaxRuntimeMs,
    graceMs: policy.gracefulShutdownMs,
    forceMs: policy.forceShutdownMs,
    absoluteDeadlineMs: documentedMaxInvocationDurationMs(policy),
  };
}
