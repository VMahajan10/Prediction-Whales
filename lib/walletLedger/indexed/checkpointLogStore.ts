import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { auditLog } from "@/lib/walletLedger/indexed/auditProgress";
import {
  getActiveEtherscanPhaseMetricsCollector,
  type EtherscanSlowPhaseMeta,
} from "@/lib/walletLedger/indexed/etherscanPhaseMetrics";
import { yieldToEventLoop } from "@/lib/walletLedger/indexed/etherscanQueryController";
import type { BlockRange } from "@/lib/walletLedger/indexed/checkpointIntervals";
import {
  highestCompletedBlock,
  normalizeRanges,
} from "@/lib/walletLedger/indexed/checkpointIntervals";
import type { QueryCheckpointIdentity } from "@/lib/walletLedger/indexed/checkpoint";
import type { RpcLog } from "@/lib/walletLedger/onchain/types";

export const CHECKPOINT_LOG_STORE_VERSION = 1;
export const CHECKPOINT_LOG_CHUNK_LINES = 50_000;
export const CHECKPOINT_APPEND_YIELD_EVERY = 2_000;
export const CHECKPOINT_READ_YIELD_EVERY = 5_000;

function measureCheckpointPhase<T>(
  phase: Parameters<
    NonNullable<ReturnType<typeof getActiveEtherscanPhaseMetricsCollector>>["measureSync"]
  >[0],
  fn: () => T,
  meta: EtherscanSlowPhaseMeta = {}
): T {
  const collector = getActiveEtherscanPhaseMetricsCollector();
  if (!collector) return fn();
  return collector.measureSync(phase, fn, meta);
}

async function measureCheckpointPhaseAsync<T>(
  phase: Parameters<
    NonNullable<ReturnType<typeof getActiveEtherscanPhaseMetricsCollector>>["measureAsync"]
  >[0],
  fn: () => Promise<T>,
  meta: EtherscanSlowPhaseMeta = {}
): Promise<T> {
  const collector = getActiveEtherscanPhaseMetricsCollector();
  if (!collector) return fn();
  return collector.measureAsync(phase, fn, meta);
}

export const CHECKPOINT_STORE_DIR = join(
  process.cwd(),
  "tmp",
  "wallet-history",
  "checkpoints"
);

/** Legacy flat-json checkpoints (pre-externalized store). */
export const LEGACY_CHECKPOINT_DIR = join(
  process.cwd(),
  "tmp",
  "wallet-indexed-audit",
  "checkpoints"
);

export interface CheckpointManifest {
  key: string;
  checkpointVersion: number;
  queryPlanVersion: string;
  identity: QueryCheckpointIdentity;
  completedRanges: BlockRange[];
  highestCompletedBlock: number | null;
  logStoreVersion: number;
  logChunkCount: number;
  logCount: number;
  lastChunkLineCount: number;
  requests: number;
  pages: number;
  errors: string[];
  createdAt: string;
  updatedAt: string;
}

export function rpcLogDedupeKey(log: RpcLog): string {
  return `${log.transactionHash}:${log.logIndex}`;
}

function sanitizeStoreDirName(key: string): string {
  const digest = createHash("sha256").update(key).digest("hex").slice(0, 16);
  const safe = key.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
  return `${safe}__${digest}`;
}

export function checkpointStoreDir(key: string): string {
  return join(CHECKPOINT_STORE_DIR, sanitizeStoreDirName(key));
}

function manifestPath(key: string): string {
  return join(checkpointStoreDir(key), "manifest.json");
}

function dedupeIndexPath(key: string): string {
  return join(checkpointStoreDir(key), "dedupe-index.txt");
}

export function chunkPath(key: string, chunkIndex: number): string {
  return join(
    checkpointStoreDir(key),
    `logs-${String(chunkIndex).padStart(6, "0")}.jsonl`
  );
}

function atomicWriteJson(path: string, value: unknown): void {
  const serialized = measureCheckpointPhase("manifest_serialize", () =>
    JSON.stringify(value, null, 2)
  );
  const tmp = `${path}.tmp`;
  measureCheckpointPhase("manifest_write", () => {
    writeFileSync(tmp, serialized);
    renameSync(tmp, path);
  });
}

export function loadDedupeIndex(storeDir: string): Set<string> {
  return measureCheckpointPhase(
    "dedupe_index_load",
    () => {
      const path = join(storeDir, "dedupe-index.txt");
      const keys = new Set<string>();
      if (!existsSync(path)) return keys;
      const content = readFileSync(path, "utf8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (trimmed) keys.add(trimmed);
      }
      return keys;
    },
    { logCount: undefined }
  );
}

function appendDedupeKeys(storeDir: string, keys: string[]): void {
  if (keys.length === 0) return;
  measureCheckpointPhase(
    "dedupe_index_append",
    () => {
      appendFileSync(join(storeDir, "dedupe-index.txt"), `${keys.join("\n")}\n`);
    },
    { logCount: keys.length }
  );
}

function listChunkFiles(storeDir: string): string[] {
  if (!existsSync(storeDir)) return [];
  return readdirSync(storeDir)
    .filter((name) => /^logs-\d{6}\.jsonl$/.test(name))
    .sort();
}

export function readLogsFromStore(key: string): RpcLog[] {
  const storeDir = checkpointStoreDir(key);
  const logs: RpcLog[] = [];
  for (const name of listChunkFiles(storeDir)) {
    const content = readFileSync(join(storeDir, name), "utf8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      logs.push(JSON.parse(trimmed) as RpcLog);
    }
  }
  return logs;
}

export async function readLogsFromStoreAsync(
  key: string,
  yieldEvery = CHECKPOINT_READ_YIELD_EVERY,
  onProgress?: (loadedCount: number) => void,
  signal?: AbortSignal
): Promise<RpcLog[]> {
  return measureCheckpointPhaseAsync(
    "read_all_logs",
    async () => {
      const storeDir = checkpointStoreDir(key);
      const logs: RpcLog[] = [];
      let parsed = 0;
      for (const name of listChunkFiles(storeDir)) {
        await yieldToEventLoop(signal);
        if (signal?.aborted) {
          throw signal.reason instanceof Error
            ? signal.reason
            : new Error("checkpoint read aborted");
        }
        const content = readFileSync(join(storeDir, name), "utf8");
        for (const line of content.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          logs.push(JSON.parse(trimmed) as RpcLog);
          parsed += 1;
          if (parsed % yieldEvery === 0) {
            onProgress?.(parsed);
            await yieldToEventLoop(signal);
          }
        }
      }
      onProgress?.(parsed);
      return logs;
    },
    { checkpointKey: key }
  );
}

export function checkpointStoreBytes(key: string): number {
  const dir = checkpointStoreDir(key);
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const name of readdirSync(dir)) {
    total += statSync(join(dir, name)).size;
  }
  return total;
}

export function walletCheckpointBytes(wallet: string): number {
  if (!existsSync(CHECKPOINT_STORE_DIR)) return 0;
  const walletTag = wallet.toLowerCase().slice(2, 10);
  let total = 0;
  for (const name of readdirSync(CHECKPOINT_STORE_DIR)) {
    if (!name.includes(walletTag)) continue;
    total += checkpointStoreBytesFromDirName(name);
  }
  return total;
}

function checkpointStoreBytesFromDirName(dirName: string): number {
  const dir = join(CHECKPOINT_STORE_DIR, dirName);
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const name of readdirSync(dir)) {
    total += statSync(join(dir, name)).size;
  }
  return total;
}

export function readCheckpointManifest(key: string): CheckpointManifest | null {
  const path = manifestPath(key);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as CheckpointManifest;
  } catch {
    return null;
  }
}

function identityTopicsMatch(
  left: (string | string[] | null)[],
  right: (string | string[] | null)[]
): boolean {
  return JSON.stringify(left ?? []) === JSON.stringify(right ?? []);
}

/** Find all on-disk stores for the same query identity (v2/v3 key variants). */
export function listCheckpointManifestsForIdentity(
  identity: QueryCheckpointIdentity
): CheckpointManifest[] {
  const walletTag = identity.wallet.toLowerCase().slice(2, 10);
  const contractTag = identity.contract.toLowerCase().slice(2, 10);
  const stableFrom = String(identity.stableFromBlock);
  const manifests: CheckpointManifest[] = [];
  if (!existsSync(CHECKPOINT_STORE_DIR)) return manifests;

  for (const dirName of readdirSync(CHECKPOINT_STORE_DIR)) {
    if (!dirName.includes(walletTag) || !dirName.includes(contractTag)) continue;
    if (!dirName.includes(stableFrom)) continue;
    const path = join(CHECKPOINT_STORE_DIR, dirName, "manifest.json");
    if (!existsSync(path)) continue;
    try {
      const manifest = JSON.parse(readFileSync(path, "utf8")) as CheckpointManifest;
      if (manifest.identity.wallet.toLowerCase() !== identity.wallet.toLowerCase()) {
        continue;
      }
      if (
        manifest.identity.contract.toLowerCase() !== identity.contract.toLowerCase()
      ) {
        continue;
      }
      if (!identityTopicsMatch(manifest.identity.topics, identity.topics ?? [])) {
        continue;
      }
      manifests.push(manifest);
    } catch {
      // skip corrupt manifests
    }
  }
  return manifests;
}

/**
 * v2 migrated stores used different checkpoint keys than v3 canonical keys.
 * Adopt the richest sibling log store into the canonical v3 key once.
 */
export function ensureCanonicalCheckpointStore(
  canonicalKey: string,
  identity: QueryCheckpointIdentity,
  checkpointVersion: number,
  queryPlanVersion: string
): CheckpointManifest | null {
  return adoptRichestSiblingLogStoreSync(
    canonicalKey,
    identity,
    checkpointVersion,
    queryPlanVersion
  );
}

function adoptRichestSiblingLogStoreSync(
  canonicalKey: string,
  identity: QueryCheckpointIdentity,
  checkpointVersion: number,
  queryPlanVersion: string
): CheckpointManifest | null {
  const siblings = listCheckpointManifestsForIdentity(identity);
  if (siblings.length === 0) return readCheckpointManifest(canonicalKey);

  const richest = [...siblings].sort((a, b) => b.logCount - a.logCount)[0]!;
  const canonical = readCheckpointManifest(canonicalKey);
  if (canonical && canonical.logCount >= richest.logCount) return canonical;
  if (!canonical && richest.key === canonicalKey) return richest;

  auditLog(
    `[checkpoint-adopt] canonical=${canonicalKey.slice(0, 60)} from=${richest.key.slice(0, 60)} logs=${richest.logCount}`
  );

  const session = canonical
    ? CheckpointLogSession.open(canonical)
    : CheckpointLogSession.create({
        key: canonicalKey,
        checkpointVersion,
        queryPlanVersion,
        identity,
      });

  const storeDir = checkpointStoreDir(richest.key);
  for (const name of listChunkFiles(storeDir)) {
    const content = readFileSync(join(storeDir, name), "utf8");
    const batch: RpcLog[] = [];
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      batch.push(JSON.parse(trimmed) as RpcLog);
      if (batch.length >= 2_000) {
        session.appendLogs(batch);
        batch.length = 0;
      }
    }
    if (batch.length > 0) session.appendLogs(batch);
  }

  const ranges = normalizeRanges([
    ...(canonical?.completedRanges ?? []),
    ...(richest.completedRanges ?? []),
  ]);
  session.updateProgress({
    completedRanges: ranges,
    requests: Math.max(canonical?.requests ?? 0, richest.requests),
    pages: Math.max(canonical?.pages ?? 0, richest.pages),
    errors: [...new Set([...(canonical?.errors ?? []), ...(richest.errors ?? [])])],
  });
  session.flush();
  auditLog(
    `[checkpoint-adopt] done canonical=${canonicalKey.slice(0, 60)} total=${session.logCount}`
  );
  return readCheckpointManifest(canonicalKey);
}

export function writeCheckpointManifest(manifest: CheckpointManifest): void {
  const dir = checkpointStoreDir(manifest.key);
  mkdirSync(dir, { recursive: true });
  atomicWriteJson(manifestPath(manifest.key), {
    ...manifest,
    updatedAt: new Date().toISOString(),
  });
}

export class CheckpointLogSession {
  private readonly storeDir: string;
  private readonly dedupeKeys: Set<string>;
  private manifest: CheckpointManifest;
  private openChunkIndex: number;
  private openChunkLines: number;

  private constructor(manifest: CheckpointManifest, dedupeKeys: Set<string>) {
    this.manifest = manifest;
    this.storeDir = checkpointStoreDir(manifest.key);
    this.dedupeKeys = dedupeKeys;
    this.openChunkIndex = Math.max(1, manifest.logChunkCount || 1);
    this.openChunkLines = manifest.lastChunkLineCount ?? 0;
    if (this.openChunkLines >= CHECKPOINT_LOG_CHUNK_LINES) {
      this.openChunkIndex += 1;
      this.openChunkLines = 0;
    }
  }

  static open(manifest: CheckpointManifest): CheckpointLogSession {
    const storeDir = checkpointStoreDir(manifest.key);
    mkdirSync(storeDir, { recursive: true });
    const dedupeKeys = loadDedupeIndex(storeDir);
    return new CheckpointLogSession(manifest, dedupeKeys);
  }

  static create(input: {
    key: string;
    checkpointVersion: number;
    queryPlanVersion: string;
    identity: QueryCheckpointIdentity;
  }): CheckpointLogSession {
    const manifest: CheckpointManifest = {
      key: input.key,
      checkpointVersion: input.checkpointVersion,
      queryPlanVersion: input.queryPlanVersion,
      identity: input.identity,
      completedRanges: [],
      highestCompletedBlock: null,
      logStoreVersion: CHECKPOINT_LOG_STORE_VERSION,
      logChunkCount: 0,
      logCount: 0,
      lastChunkLineCount: 0,
      requests: 0,
      pages: 0,
      errors: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    return CheckpointLogSession.open(manifest);
  }

  get logCount(): number {
    return this.manifest.logCount;
  }

  get manifestSnapshot(): CheckpointManifest {
    return { ...this.manifest };
  }

  readAllLogs(): RpcLog[] {
    return readLogsFromStore(this.manifest.key);
  }

  async readAllLogsAsync(
    yieldEvery = CHECKPOINT_READ_YIELD_EVERY,
    onProgress?: (loadedCount: number) => void,
    signal?: AbortSignal
  ): Promise<RpcLog[]> {
    return readLogsFromStoreAsync(this.manifest.key, yieldEvery, onProgress, signal);
  }

  appendLogs(logs: RpcLog[]): number {
    if (logs.length === 0) return 0;
    return measureCheckpointPhase(
      "append_logs",
      () => this.appendLogsSync(logs),
      { logCount: logs.length, checkpointKey: this.manifest.key }
    );
  }

  async appendLogsAsync(logs: RpcLog[]): Promise<number> {
    if (logs.length === 0) return 0;
    return measureCheckpointPhaseAsync(
      "append_logs",
      () => this.appendLogsSyncWithYields(logs),
      { logCount: logs.length, checkpointKey: this.manifest.key }
    );
  }

  private appendLogsSync(logs: RpcLog[]): number {
    if (logs.length === 0) return 0;
    const newKeys: string[] = [];
    const toWrite: RpcLog[] = [];
    for (const log of logs) {
      const key = rpcLogDedupeKey(log);
      if (this.dedupeKeys.has(key)) continue;
      this.dedupeKeys.add(key);
      newKeys.push(key);
      toWrite.push(log);
    }
    if (toWrite.length === 0) return 0;

    mkdirSync(this.storeDir, { recursive: true });
    let pending = "";
    for (const log of toWrite) {
      if (this.openChunkLines >= CHECKPOINT_LOG_CHUNK_LINES) {
        this.rotateChunkIfNeeded();
      }
      const path = chunkPath(this.manifest.key, this.openChunkIndex);
      pending += `${JSON.stringify(log)}\n`;
      this.openChunkLines += 1;
      if (pending.length >= 256_000) {
        appendFileSync(path, pending);
        pending = "";
      }
      if (this.openChunkLines >= CHECKPOINT_LOG_CHUNK_LINES) {
        if (pending) {
          appendFileSync(path, pending);
          pending = "";
        }
        this.rotateChunkIfNeeded();
      }
    }
    if (pending) {
      appendFileSync(chunkPath(this.manifest.key, this.openChunkIndex), pending);
    }
    appendDedupeKeys(this.storeDir, newKeys);
    this.manifest.logCount += toWrite.length;
    this.manifest.logChunkCount = Math.max(
      this.manifest.logChunkCount,
      this.openChunkIndex
    );
    this.manifest.lastChunkLineCount = this.openChunkLines;
    return toWrite.length;
  }

  private async appendLogsSyncWithYields(logs: RpcLog[]): Promise<number> {
    if (logs.length === 0) return 0;
    const newKeys: string[] = [];
    const toWrite: RpcLog[] = [];
    for (const log of logs) {
      const key = rpcLogDedupeKey(log);
      if (this.dedupeKeys.has(key)) continue;
      this.dedupeKeys.add(key);
      newKeys.push(key);
      toWrite.push(log);
    }
    if (toWrite.length === 0) return 0;

    mkdirSync(this.storeDir, { recursive: true });
    let pending = "";
    let processed = 0;
    for (const log of toWrite) {
      if (this.openChunkLines >= CHECKPOINT_LOG_CHUNK_LINES) {
        this.rotateChunkIfNeeded();
      }
      const path = chunkPath(this.manifest.key, this.openChunkIndex);
      pending += `${JSON.stringify(log)}\n`;
      this.openChunkLines += 1;
      processed += 1;
      if (pending.length >= 256_000) {
        appendFileSync(path, pending);
        pending = "";
      }
      if (this.openChunkLines >= CHECKPOINT_LOG_CHUNK_LINES) {
        if (pending) {
          appendFileSync(path, pending);
          pending = "";
        }
        this.rotateChunkIfNeeded();
      }
      if (processed % CHECKPOINT_APPEND_YIELD_EVERY === 0) {
        await yieldToEventLoop();
      }
    }
    if (pending) {
      appendFileSync(chunkPath(this.manifest.key, this.openChunkIndex), pending);
    }
    appendDedupeKeys(this.storeDir, newKeys);
    this.manifest.logCount += toWrite.length;
    this.manifest.logChunkCount = Math.max(
      this.manifest.logChunkCount,
      this.openChunkIndex
    );
    this.manifest.lastChunkLineCount = this.openChunkLines;
    return toWrite.length;
  }

  private rotateChunkIfNeeded(): void {
    if (this.openChunkLines < CHECKPOINT_LOG_CHUNK_LINES) return;
    this.manifest.logChunkCount = Math.max(
      this.manifest.logChunkCount,
      this.openChunkIndex
    );
    this.openChunkIndex += 1;
    this.openChunkLines = 0;
  }

  updateProgress(input: {
    completedRanges: BlockRange[];
    requests: number;
    pages: number;
    errors: string[];
  }): void {
    const ranges = normalizeRanges(input.completedRanges);
    this.manifest.completedRanges = ranges;
    this.manifest.highestCompletedBlock = highestCompletedBlock(ranges);
    this.manifest.requests = input.requests;
    this.manifest.pages = input.pages;
    this.manifest.errors = input.errors;
  }

  flush(): void {
    measureCheckpointPhase(
      "flush",
      () => {
        this.manifest.logChunkCount = Math.max(
          this.manifest.logChunkCount,
          this.openChunkIndex
        );
        this.manifest.lastChunkLineCount = this.openChunkLines;
        writeCheckpointManifest(this.manifest);
      },
      { checkpointKey: this.manifest.key }
    );
  }
}

export function migrateLegacyFlatCheckpoint(input: {
  key: string;
  checkpointVersion: number;
  queryPlanVersion: string;
  identity: QueryCheckpointIdentity;
  completedRanges: BlockRange[];
  highestCompletedBlock: number | null;
  logs: RpcLog[];
  requests: number;
  pages: number;
  errors: string[];
  createdAt: string;
}): CheckpointManifest {
  const session = CheckpointLogSession.create({
    key: input.key,
    checkpointVersion: input.checkpointVersion,
    queryPlanVersion: input.queryPlanVersion,
    identity: input.identity,
  });
  session.appendLogs(input.logs);
  session.updateProgress({
    completedRanges: input.completedRanges,
    requests: input.requests,
    pages: input.pages,
    errors: input.errors,
  });
  const snapshot = session.manifestSnapshot;
  writeCheckpointManifest({ ...snapshot, createdAt: input.createdAt });
  auditLog(
    `[checkpoint-migrate] flat-json->log-store key=${input.key.slice(0, 60)} logs=${input.logs.length}`
  );
  return readCheckpointManifest(input.key)!;
}
