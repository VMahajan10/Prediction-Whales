import { getDb, isDatabaseEnabled } from "@/lib/crossmarket/store/db";
import { sql } from "drizzle-orm";
import { isDeterministicSqlError, isRetryableTransientError, retryTransient } from "@/lib/walletLedger/indexed/shadow/transientRetry";

const FAILURE_WINDOW_MS = 30_000;
const OPEN_THRESHOLD = 3;
const PROBE_COOLDOWN_MS = 15_000;

export class DbCircuitOpenError extends Error {
  constructor(message = "database circuit open") {
    super(message);
    this.name = "DbCircuitOpenError";
  }
}

interface DbCircuitState {
  consecutiveFailures: number;
  lastFailureAt: number;
  openedAt: number | null;
  lastProbeAt: number;
}

const state: DbCircuitState = {
  consecutiveFailures: 0,
  lastFailureAt: 0,
  openedAt: null,
  lastProbeAt: 0,
};

export function isDbCircuitOpen(): boolean {
  return state.openedAt != null;
}

export function getDbCircuitSnapshot(): Readonly<DbCircuitState> {
  return { ...state };
}

export function recordDbSuccess(): void {
  state.consecutiveFailures = 0;
  state.openedAt = null;
}

export function recordDbFailure(error: unknown): void {
  if (isDeterministicSqlError(error)) return;
  if (!isRetryableTransientError(error)) return;
  const now = Date.now();
  if (now - state.lastFailureAt > FAILURE_WINDOW_MS) {
    state.consecutiveFailures = 0;
  }
  state.consecutiveFailures += 1;
  state.lastFailureAt = now;
  if (state.consecutiveFailures >= OPEN_THRESHOLD) {
    state.openedAt = now;
    console.error(
      `[db-circuit] open consecutiveFailures=${state.consecutiveFailures}`
    );
  }
}

export async function probeDbHealth(): Promise<boolean> {
  if (!isDatabaseEnabled()) return false;
  const now = Date.now();
  if (now - state.lastProbeAt < PROBE_COOLDOWN_MS) {
    return !isDbCircuitOpen();
  }
  state.lastProbeAt = now;
  try {
    const db = getDb();
    await db.execute(sql`SELECT 1`);
    recordDbSuccess();
    if (state.openedAt != null) {
      console.error("[db-circuit] closed after successful probe");
    }
    return true;
  } catch (error) {
    recordDbFailure(error);
    return false;
  }
}

export async function withDbCircuit<T>(
  label: string,
  fn: () => Promise<T>,
  options: { allowWhenOpen?: boolean } = {}
): Promise<T> {
  if (isDbCircuitOpen() && !options.allowWhenOpen) {
    const healthy = await probeDbHealth();
    if (!healthy) {
      throw new DbCircuitOpenError(`database circuit open (${label})`);
    }
  }
  try {
    const result = await retryTransient(fn, { maxAttempts: 3, label });
    recordDbSuccess();
    return result;
  } catch (error) {
    recordDbFailure(error);
    throw error;
  }
}

export function resetDbCircuitForTests(): void {
  state.consecutiveFailures = 0;
  state.lastFailureAt = 0;
  state.openedAt = null;
  state.lastProbeAt = 0;
}
