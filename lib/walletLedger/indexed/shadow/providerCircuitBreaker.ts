import { FetchTimeoutError } from "@/lib/fetchWithTimeout";
import { isTransientFetchError } from "@/lib/walletLedger/indexed/etherscanRetry";

const OPEN_THRESHOLD = 3;
const COOLDOWN_MS = 45_000;
const PROBE_COOLDOWN_MS = 15_000;

export class ProviderCircuitOpenError extends Error {
  constructor(message = "etherscan provider circuit open") {
    super(message);
    this.name = "ProviderCircuitOpenError";
  }
}

interface ProviderCircuitState {
  consecutiveFailures: number;
  openedAt: number | null;
  lastProbeAt: number;
}

const state: ProviderCircuitState = {
  consecutiveFailures: 0,
  openedAt: null,
  lastProbeAt: 0,
};

export function isProviderCircuitOpen(): boolean {
  if (state.openedAt == null) return false;
  if (Date.now() - state.openedAt >= COOLDOWN_MS) {
    return false;
  }
  return true;
}

export function recordProviderSuccess(): void {
  state.consecutiveFailures = 0;
  state.openedAt = null;
}

export function recordProviderFailure(error: unknown): void {
  const transient =
    error instanceof FetchTimeoutError ||
    error instanceof ProviderCircuitOpenError ||
    isTransientFetchError(error);
  if (!transient) return;
  state.consecutiveFailures += 1;
  if (state.consecutiveFailures >= OPEN_THRESHOLD) {
    state.openedAt = Date.now();
    console.error(
      `[provider-circuit] open consecutiveFailures=${state.consecutiveFailures}`
    );
  }
}

export async function awaitProviderCircuitCooldown(): Promise<boolean> {
  if (!isProviderCircuitOpen()) return true;
  const elapsed = Date.now() - (state.openedAt ?? 0);
  if (elapsed < COOLDOWN_MS) {
    return false;
  }
  const now = Date.now();
  if (now - state.lastProbeAt < PROBE_COOLDOWN_MS) {
    return !isProviderCircuitOpen();
  }
  state.lastProbeAt = now;
  state.consecutiveFailures = 0;
  state.openedAt = null;
  console.error("[provider-circuit] cooldown elapsed — half-open probe allowed");
  return true;
}

export function assertProviderCircuitAllowsRequest(): void {
  if (isProviderCircuitOpen()) {
    throw new ProviderCircuitOpenError();
  }
}

export function resetProviderCircuitForTests(): void {
  state.consecutiveFailures = 0;
  state.openedAt = null;
  state.lastProbeAt = 0;
}
