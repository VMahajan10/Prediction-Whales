import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

export type BlockTimestampErrorClass = "transient" | "deterministic";

export interface BlockTimestampFailureEntry {
  blockNumber: number;
  lastFailedAt: string;
  attemptCount: number;
  errorClass: BlockTimestampErrorClass;
  nextRetryAt: string;
}

const MAX_TRANSIENT_COOLDOWN_MS = 30 * 60 * 1000;
const MAX_DETERMINISTIC_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const BASE_TRANSIENT_MS = 60_000;
const BASE_DETERMINISTIC_MS = 300_000;

export function classifyBlockTimestampFailure(
  _error?: string | null
): BlockTimestampErrorClass {
  return "transient";
}

export function computeNextRetryAt(
  attemptCount: number,
  errorClass: BlockTimestampErrorClass,
  now = Date.now()
): string {
  const base =
    errorClass === "deterministic" ? BASE_DETERMINISTIC_MS : BASE_TRANSIENT_MS;
  const max =
    errorClass === "deterministic"
      ? MAX_DETERMINISTIC_COOLDOWN_MS
      : MAX_TRANSIENT_COOLDOWN_MS;
  const delay = Math.min(max, base * 2 ** Math.max(0, attemptCount - 1));
  const jitter = Math.floor(Math.random() * 0.1 * delay);
  return new Date(now + delay + jitter).toISOString();
}

export function shouldSkipFailedBlock(
  entry: BlockTimestampFailureEntry,
  now = Date.now()
): boolean {
  return Date.parse(entry.nextRetryAt) > now;
}

export function readFailureStore(
  cacheDir: string,
  chainId: string
): Record<string, BlockTimestampFailureEntry> {
  const path = join(cacheDir, `chain-${chainId}.failures.json`);
  if (!existsSync(path)) return migrateLegacyFailedArray(cacheDir, chainId);
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<
      string,
      BlockTimestampFailureEntry
    >;
    const store: Record<string, BlockTimestampFailureEntry> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (value?.blockNumber != null && value.nextRetryAt) {
        store[key] = value;
      }
    }
    return store;
  }
  catch {
    return {};
  }
}

function migrateLegacyFailedArray(
  cacheDir: string,
  chainId: string
): Record<string, BlockTimestampFailureEntry> {
  const legacyPath = join(cacheDir, `chain-${chainId}.failed.json`);
  if (!existsSync(legacyPath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(legacyPath, "utf8"));
    if (!Array.isArray(parsed)) return {};
    const now = new Date().toISOString();
    const store: Record<string, BlockTimestampFailureEntry> = {};
    for (const block of parsed) {
      const n = Number(block);
      if (!Number.isFinite(n) || n <= 0) continue;
      store[String(n)] = {
        blockNumber: n,
        lastFailedAt: now,
        attemptCount: 1,
        errorClass: "transient",
        nextRetryAt: computeNextRetryAt(1, "transient"),
      };
    }
    return store;
  }
  catch {
    return {};
  }
}

export function persistFailureStore(
  cacheDir: string,
  chainId: string,
  store: Record<string, BlockTimestampFailureEntry>
): void {
  mkdirSync(cacheDir, { recursive: true });
  const finalPath = join(cacheDir, `chain-${chainId}.failures.json`);
  const tempPath = `${finalPath}.${process.pid}.tmp`;
  const fd = openSync(tempPath, "w");
  try {
    writeSync(fd, JSON.stringify(store));
    fsyncSync(fd);
  }
  finally {
    closeSync(fd);
  }
  renameSync(tempPath, finalPath);
}

export function recordBlockFailure(
  store: Record<string, BlockTimestampFailureEntry>,
  block: number,
  errorClass: BlockTimestampErrorClass = "transient"
): void {
  const key = String(block);
  const existing = store[key];
  const attemptCount = (existing?.attemptCount ?? 0) + 1;
  store[key] = {
    blockNumber: block,
    lastFailedAt: new Date().toISOString(),
    attemptCount,
    errorClass,
    nextRetryAt: computeNextRetryAt(attemptCount, errorClass),
  };
}

export function clearBlockFailure(
  store: Record<string, BlockTimestampFailureEntry>,
  block: number
): void {
  delete store[String(block)];
}

export function countEligibleFailedBlocks(
  store: Record<string, BlockTimestampFailureEntry>,
  now = Date.now()
): number {
  return Object.values(store).filter((e) => shouldSkipFailedBlock(e, now)).length;
}
