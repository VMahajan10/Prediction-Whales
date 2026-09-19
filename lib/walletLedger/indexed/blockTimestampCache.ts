import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { auditLog } from "@/lib/walletLedger/indexed/auditProgress";
import {
  classifyBlockTimestampFailure,
  clearBlockFailure,
  countEligibleFailedBlocks,
  readFailureStore,
  recordBlockFailure,
  persistFailureStore,
  shouldSkipFailedBlock,
} from "@/lib/walletLedger/indexed/blockTimestampFailures";
import { PolygonRpcClient } from "@/lib/walletLedger/onchain/rpc";
import { POLYGON_RPC_URLS } from "@/lib/walletLedger/onchain/rpcUrls";
import type { RpcLog } from "@/lib/walletLedger/onchain/types";

const DEFAULT_CACHE_DIR = join(
  process.cwd(),
  "tmp",
  "wallet-history",
  "block-timestamps"
);

export const POLYGON_CHAIN_ID = "137";
const DEFAULT_CONCURRENCY = 32;

/** Module-level in-flight dedup across concurrent resolveBlockTimestamps calls. */
const inFlightByKey = new Map<string, Promise<number | null>>();

let cacheDirOverride: string | null = null;

export function setBlockTimestampCacheDirForTests(dir: string | null): void {
  cacheDirOverride = dir;
}

function cacheDir(): string {
  return cacheDirOverride ?? DEFAULT_CACHE_DIR;
}

export interface BlockTimestampCacheStats {
  requestedUnique: number;
  diskEntriesLoaded: number;
  logSeededUnique: number;
  hits: number;
  misses: number;
  inFlightReused: number;
  logicalRpcLookups: number;
  rpcAttempts: number;
  retries: number;
  failures: number;
  successes: number;
  persistedEntries: number;
  skippedKnownFailed: number;
  timestampCoveragePct: number;
  timestampMissingBlocks: number;
  timestampKnownFailedBlocks: number;
  elapsedMs: number;
  /** @deprecated use logicalRpcLookups / rpcAttempts */
  requested: number;
  unique: number;
  logSeeded: number;
  cacheHits: number;
  cacheMisses: number;
  rpcCalls: number;
}

function cachePath(chainId: string): string {
  return join(cacheDir(), `chain-${chainId}.json`);
}

export function readBlockTimestampStore(
  chainId: string
): Record<string, number> {
  const path = cachePath(chainId);
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<
      string,
      unknown
    >;
    const store: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed)) {
      const block = Number(key);
      const ts = Number(value);
      if (Number.isFinite(block) && block > 0 && Number.isFinite(ts) && ts > 0) {
        store[String(block)] = ts;
      }
    }
    return store;
  }
  catch {
    return {};
  }
}

function failedBlocksPath(chainId: string): string {
  return join(cacheDir(), `chain-${chainId}.failed.json`);
}

function readKnownFailedBlocks(
  chainId: string,
  now = Date.now()
): {
  skipBlocks: Set<number>;
  cooldownBlocks: number;
  totalFailedEntries: number;
} {
  const store = readFailureStore(cacheDir(), chainId);
  const skipBlocks = new Set<number>();
  for (const entry of Object.values(store)) {
    if (shouldSkipFailedBlock(entry, now)) {
      skipBlocks.add(entry.blockNumber);
    }
  }
  return {
    skipBlocks,
    cooldownBlocks: skipBlocks.size,
    totalFailedEntries: Object.keys(store).length,
  };
}

function atomicWriteStore(
  chainId: string,
  store: Record<string, number>
): void {
  mkdirSync(cacheDir(), { recursive: true });
  const finalPath = cachePath(chainId);
  const tempPath = `${finalPath}.${process.pid}.${Date.now()}.tmp`;
  const payload = JSON.stringify(store);
  const fd = openSync(tempPath, "w");
  try {
    writeSync(fd, payload);
    fsyncSync(fd);
  }
  finally {
    closeSync(fd);
  }
  renameSync(tempPath, finalPath);
}

function mergePersistEntries(
  chainId: string,
  entries: Record<string, number>
): number {
  if (Object.keys(entries).length === 0) {
    return Object.keys(readBlockTimestampStore(chainId)).length;
  }
  const latest = readBlockTimestampStore(chainId);
  let added = 0;
  for (const [key, value] of Object.entries(entries)) {
    if (latest[key] == null) {
      latest[key] = value;
      added += 1;
    }
  }
  if (added > 0) {
    atomicWriteStore(chainId, latest);
  }
  return Object.keys(latest).length;
}

function parseBlockNumber(blockNumber: string): number | null {
  const n = Number.parseInt(
    blockNumber,
    blockNumber.startsWith("0x") ? 16 : 10
  );
  return Number.isFinite(n) && n > 0 ? n : null;
}

export interface LogSeedStats {
  seededUnique: number;
  logsWithTimestamp: number;
  uniqueBlocksRepresented: number;
}

/** Extract block timestamps already present on indexed-provider log rows. */
export function seedBlockTimestampsFromLogs(
  logs: RpcLog[],
  store: Record<string, number>
): LogSeedStats {
  const seededBlocks = new Set<number>();
  let logsWithTimestamp = 0;
  const blocksRepresented = new Set<number>();

  for (const log of logs) {
    const block = parseBlockNumber(log.blockNumber);
    if (block == null) continue;
    blocksRepresented.add(block);
    if (log.blockTimestamp == null) continue;
    logsWithTimestamp += 1;
    const key = String(block);
    if (store[key] == null) {
      store[key] = log.blockTimestamp;
      seededBlocks.add(block);
    }
  }

  return {
    seededUnique: seededBlocks.size,
    logsWithTimestamp,
    uniqueBlocksRepresented: blocksRepresented.size,
  };
}

function createTimestampRpcClient(): PolygonRpcClient {
  const primary = process.env.POLYGON_RPC_URL?.trim();
  const rpcUrls =
    primary != null && primary !== ""
      ? [primary, ...POLYGON_RPC_URLS.filter((u) => u !== primary)]
      : POLYGON_RPC_URLS;
  return new PolygonRpcClient({
    rpcUrls,
    maxRetries: 1,
    retryDelayMs: 100,
  });
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, workerId: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let index = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, Math.max(items.length, 1)) },
    async (_, workerId) => {
      while (index < items.length) {
        const current = index;
        index += 1;
        results[current] = await fn(items[current]!, workerId);
      }
    }
  );
  await Promise.all(workers);
  return results;
}

async function fetchBlockTimestampDeduped(
  chainId: string,
  block: number,
  rpc: PolygonRpcClient,
  counters: {
    logicalRpcLookups: number;
    rpcAttempts: number;
    retries: number;
    failures: number;
    successes: number;
    inFlightReused: number;
  }
): Promise<number | null> {
  const flightKey = `${chainId}:${block}`;
  let existing = inFlightByKey.get(flightKey);
  if (existing) {
    counters.inFlightReused += 1;
    return existing;
  }

  let resolveOuter!: (value: number | null) => void;
  const promise = new Promise<number | null>((resolve) => {
    resolveOuter = resolve;
  });
  inFlightByKey.set(flightKey, promise);

  try {
    counters.logicalRpcLookups += 1;
    const attemptsBefore = rpc.rpcCalls;
    const retriesBefore = rpc.retries;
    const ts = await rpc.getBlockTimestamp(block);
    counters.rpcAttempts += rpc.rpcCalls - attemptsBefore;
    counters.retries += rpc.retries - retriesBefore;
    if (ts != null) {
      counters.successes += 1;
      resolveOuter(ts);
      return ts;
    }
    counters.failures += 1;
    resolveOuter(null);
    return null;
  }
  catch (error) {
    resolveOuter(null);
    throw error;
  }
  finally {
    inFlightByKey.delete(flightKey);
  }
}

function toLegacyStats(stats: BlockTimestampCacheStats): void {
  stats.requested = stats.requestedUnique;
  stats.unique = stats.requestedUnique;
  stats.logSeeded = stats.logSeededUnique;
  stats.cacheHits = stats.hits;
  stats.cacheMisses = stats.misses;
  stats.rpcCalls = stats.rpcAttempts;
}

/**
 * Resolve block timestamps with a persistent chain-level cache.
 * Same block is never fetched twice across wallets or runs.
 */
export async function resolveBlockTimestamps(
  blockNumbers: Iterable<number>,
  _legacyRpc?: PolygonRpcClient,
  options: {
    chainId?: string;
    concurrency?: number;
    logSeeds?: RpcLog[];
    timestampRpc?: PolygonRpcClient;
  } = {}
): Promise<{ timestamps: Map<number, number>; stats: BlockTimestampCacheStats }> {
  const chainId = options.chainId ?? POLYGON_CHAIN_ID;
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  /** Dedicated per-worker clients — never reuse pipeline RPC. */
  const clientFactory =
    options.timestampRpc ?? _legacyRpc ?? null;
  const workerRpcClients = Array.from({ length: concurrency }, () =>
    clientFactory ?? createTimestampRpcClient()
  );
  const started = Date.now();

  const uniqueMissingBlocks = [
    ...new Set(
      [...blockNumbers].filter((n) => Number.isFinite(n) && n > 0)
    ),
  ];
  const store = readBlockTimestampStore(chainId);
  const diskEntriesLoaded = Object.keys(store).length;
  const failureStore = readFailureStore(cacheDir(), chainId);
  const knownFailed = readKnownFailedBlocks(chainId);

  const seedStats = options.logSeeds
    ? seedBlockTimestampsFromLogs(options.logSeeds, store)
    : { seededUnique: 0, logsWithTimestamp: 0, uniqueBlocksRepresented: 0 };

  const timestamps = new Map<number, number>();
  const uniqueMissing: number[] = [];
  let hits = 0;
  let skippedKnownFailed = 0;

  for (const block of uniqueMissingBlocks) {
    const cached = store[String(block)];
    if (cached != null) {
      hits += 1;
      timestamps.set(block, cached);
    }
    else if (knownFailed.skipBlocks.has(block)) {
      skippedKnownFailed += 1;
    }
    else {
      uniqueMissing.push(block);
    }
  }

  const counters = {
    logicalRpcLookups: 0,
    rpcAttempts: 0,
    retries: 0,
    failures: 0,
    successes: 0,
    inFlightReused: 0,
  };

  const pendingPersist: Record<string, number> = {};
  const PERSIST_BATCH = 500;

  await mapWithConcurrency(uniqueMissing, concurrency, async (block, workerId) => {
    const ts = await fetchBlockTimestampDeduped(
      chainId,
      block,
      workerRpcClients[workerId]!,
      counters
    );
    if (ts != null) {
      const key = String(block);
      store[key] = ts;
      timestamps.set(block, ts);
      pendingPersist[key] = ts;
      clearBlockFailure(failureStore, block);
      if (Object.keys(pendingPersist).length >= PERSIST_BATCH) {
        mergePersistEntries(chainId, pendingPersist);
        for (const k of Object.keys(pendingPersist)) delete pendingPersist[k];
      }
    }
    else {
      recordBlockFailure(
        failureStore,
        block,
        classifyBlockTimestampFailure()
      );
    }
  });

  if (Object.keys(pendingPersist).length > 0) {
    mergePersistEntries(chainId, pendingPersist);
  }
  persistFailureStore(cacheDir(), chainId, failureStore);

  const persistedEntries = Object.keys(readBlockTimestampStore(chainId)).length;
  const resolvedBlocks = timestamps.size;
  const timestampMissingBlocks =
    uniqueMissingBlocks.length - resolvedBlocks - skippedKnownFailed;
  const timestampCoveragePct =
    uniqueMissingBlocks.length > 0
      ? resolvedBlocks / uniqueMissingBlocks.length
      : 1;
  const timestampKnownFailedBlocks = countEligibleFailedBlocks(failureStore);

  const stats: BlockTimestampCacheStats = {
    requestedUnique: uniqueMissingBlocks.length,
    diskEntriesLoaded,
    logSeededUnique: seedStats.seededUnique,
    hits,
    misses: uniqueMissing.length,
    inFlightReused: counters.inFlightReused,
    logicalRpcLookups: counters.logicalRpcLookups,
    rpcAttempts: counters.rpcAttempts,
    retries: counters.retries,
    failures: counters.failures,
    successes: counters.successes,
    persistedEntries,
    skippedKnownFailed,
    timestampCoveragePct,
    timestampMissingBlocks,
    timestampKnownFailedBlocks,
    elapsedMs: Date.now() - started,
    requested: 0,
    unique: 0,
    logSeeded: 0,
    cacheHits: 0,
    cacheMisses: 0,
    rpcCalls: 0,
  };
  toLegacyStats(stats);

  auditLog(
    [
      "[block-cache]",
      `requestedUnique=${stats.requestedUnique}`,
      `diskEntriesLoaded=${stats.diskEntriesLoaded}`,
      `logSeededUnique=${stats.logSeededUnique}`,
      `logTsLogs=${seedStats.logsWithTimestamp}`,
      `logTsBlocks=${seedStats.uniqueBlocksRepresented}`,
      `hits=${stats.hits}`,
      `misses=${stats.misses}`,
      `inFlightReused=${stats.inFlightReused}`,
      `logicalRpcLookups=${stats.logicalRpcLookups}`,
      `rpcAttempts=${stats.rpcAttempts}`,
      `retries=${stats.retries}`,
      `failures=${stats.failures}`,
      `successes=${stats.successes}`,
      `skippedKnownFailed=${stats.skippedKnownFailed}`,
      `timestampCoveragePct=${stats.timestampCoveragePct.toFixed(4)}`,
      `timestampMissingBlocks=${stats.timestampMissingBlocks}`,
      `timestampKnownFailedBlocks=${stats.timestampKnownFailedBlocks}`,
      `persistedEntries=${stats.persistedEntries}`,
      `elapsedMs=${stats.elapsedMs}`,
    ].join(" ")
  );

  return { timestamps, stats };
}

export function clearBlockTimestampCache(chainId = POLYGON_CHAIN_ID): void {
  if (existsSync(cachePath(chainId))) {
    atomicWriteStore(chainId, {});
  }
  const failedPath = failedBlocksPath(chainId);
  if (existsSync(failedPath)) {
    writeFileSync(failedPath, "[]");
  }
  const failuresPath = join(cacheDir(), `chain-${chainId}.failures.json`);
  if (existsSync(failuresPath)) {
    writeFileSync(failuresPath, "{}");
  }
}
