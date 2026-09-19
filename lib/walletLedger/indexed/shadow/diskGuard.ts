import { statfsSync } from "node:fs";

export const DISK_GUARD_MIN_START_GIB = 10;
export const DISK_GUARD_WARN_GIB = 20;

export class DiskSpaceGuardError extends Error {
  override readonly name = "DiskSpaceGuardError";

  constructor(message: string) {
    super(message);
  }
}

export function getFreeDiskBytes(path: string = process.cwd()): number {
  const stats = statfsSync(path);
  return Number(stats.bfree) * stats.bsize;
}

export function getFreeDiskGiB(path: string = process.cwd()): number {
  return getFreeDiskBytes(path) / 1024 ** 3;
}

export function assertDiskSpaceForBatchStart(path?: string): void {
  const freeGiB = getFreeDiskGiB(path);
  if (freeGiB < DISK_GUARD_MIN_START_GIB) {
    throw new DiskSpaceGuardError(
      `Refusing batch start: free disk ${freeGiB.toFixed(2)} GiB < ${DISK_GUARD_MIN_START_GIB} GiB minimum`
    );
  }
  if (freeGiB < DISK_GUARD_WARN_GIB) {
    console.error(
      `[disk-guard] WARNING: free disk ${freeGiB.toFixed(2)} GiB (< ${DISK_GUARD_WARN_GIB} GiB recommended)`
    );
  } else {
    console.error(`[disk-guard] free disk ${freeGiB.toFixed(2)} GiB — ok to start`);
  }
}

/** Stop scheduling new wallets when free disk drops below the hard floor. */
export function canScheduleMoreWallets(path?: string): boolean {
  return getFreeDiskGiB(path) >= DISK_GUARD_MIN_START_GIB;
}
