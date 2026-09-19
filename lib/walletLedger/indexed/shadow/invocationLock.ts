import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const STAGE_C_INVOCATION_LOCK_DIR = join(
  process.cwd(),
  "tmp",
  "wallet-history",
  "shadow-compare"
);

export const STAGE_C_INVOCATION_LOCK_FILE = join(
  STAGE_C_INVOCATION_LOCK_DIR,
  "stageC-invocation.lock"
);

export interface StageCInvocationLockRecord {
  pid: number;
  batchId: string;
  startedAt: string;
}

export class StageCInvocationLockError extends Error {
  override readonly name = "StageCInvocationLockError";

  constructor(
    message: string,
    readonly existing?: StageCInvocationLockRecord
  ) {
    super(message);
  }
}

function readLockRecord(): StageCInvocationLockRecord | null {
  if (!existsSync(STAGE_C_INVOCATION_LOCK_FILE)) return null;
  try {
    return JSON.parse(
      readFileSync(STAGE_C_INVOCATION_LOCK_FILE, "utf8")
    ) as StageCInvocationLockRecord;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function acquireStageCInvocationLock(batchId: string): void {
  const existing = readLockRecord();
  if (existing && isProcessAlive(existing.pid)) {
    throw new StageCInvocationLockError(
      `Stage C invocation already running pid=${existing.pid} batchId=${existing.batchId} startedAt=${existing.startedAt}`,
      existing
    );
  }
  if (existing) {
    unlinkSync(STAGE_C_INVOCATION_LOCK_FILE);
  }
  const record: StageCInvocationLockRecord = {
    pid: process.pid,
    batchId,
    startedAt: new Date().toISOString(),
  };
  writeFileSync(STAGE_C_INVOCATION_LOCK_FILE, JSON.stringify(record), "utf8");
}

export function releaseStageCInvocationLock(): void {
  const existing = readLockRecord();
  if (!existing) return;
  if (existing.pid !== process.pid) return;
  unlinkSync(STAGE_C_INVOCATION_LOCK_FILE);
}
