import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { auditLog } from "@/lib/walletLedger/indexed/auditProgress";
import {
  computeCheckpointResumePlan,
  formatBlockRanges,
  highestCompletedBlock,
  normalizeRanges,
  type BlockRange,
  type CheckpointResumePlan,
} from "@/lib/walletLedger/indexed/checkpointIntervals";
import {
  CHECKPOINT_LOG_STORE_VERSION,
  LEGACY_CHECKPOINT_DIR,
  CHECKPOINT_STORE_DIR,
  ensureCanonicalCheckpointStore,
  migrateLegacyFlatCheckpoint,
  readCheckpointManifest,
  readLogsFromStore,
  type CheckpointManifest,
} from "@/lib/walletLedger/indexed/checkpointLogStore";
import type { RpcLog } from "@/lib/walletLedger/onchain/types";

/** Bump when checkpoint manifest schema changes. */
export const CHECKPOINT_SCHEMA_VERSION = 3;

/**
 * Bump when indexed query plan semantics change (contracts, topics, roles).
 * Incompatible checkpoints are not silently reused.
 */
export const QUERY_PLAN_VERSION = "2d-etherscan-v1";

const POLYGON_CHAIN_ID = "137";

export interface QueryCheckpointIdentity {
  providerId: string;
  chainId: string;
  wallet: string;
  contract: string;
  stableFromBlock: number;
  topics: (string | string[] | null)[];
}

/** In-memory checkpoint view used by Etherscan provider. */
export interface EtherscanQueryCheckpoint {
  key: string;
  checkpointVersion: number;
  queryPlanVersion: string;
  identity: QueryCheckpointIdentity;
  /** @deprecated use completedRanges */
  completedWindowEnds?: number[];
  completedRanges: BlockRange[];
  highestCompletedBlock: number | null;
  logCount: number;
  logStoreVersion: number;
  /** Populated lazily when logs are needed in memory. */
  logs: RpcLog[];
  requests: number;
  pages: number;
  errors: string[];
  createdAt: string;
  updatedAt: string;
}

export function checkpointPath(key: string): string {
  return join(LEGACY_CHECKPOINT_DIR, `${key}.json`);
}

function manifestToCheckpoint(manifest: CheckpointManifest, logs: RpcLog[]): EtherscanQueryCheckpoint {
  return {
    key: manifest.key,
    checkpointVersion: manifest.checkpointVersion,
    queryPlanVersion: manifest.queryPlanVersion,
    identity: manifest.identity,
    completedRanges: manifest.completedRanges,
    highestCompletedBlock: manifest.highestCompletedBlock,
    logCount: manifest.logCount,
    logStoreVersion: manifest.logStoreVersion,
    logs,
    requests: manifest.requests,
    pages: manifest.pages,
    errors: manifest.errors,
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
  };
}

function readLegacyFlatCheckpoint(key: string): EtherscanQueryCheckpoint | null {
  const path = checkpointPath(key);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as EtherscanQueryCheckpoint & {
      logCount?: number;
      logStoreVersion?: number;
    };
    const completedRanges = normalizeRanges(raw.completedRanges ?? []);
    const logs = raw.logs ?? [];
    return {
      ...raw,
      completedRanges,
      highestCompletedBlock:
        raw.highestCompletedBlock ?? highestCompletedBlock(completedRanges),
      checkpointVersion: raw.checkpointVersion ?? 1,
      queryPlanVersion: raw.queryPlanVersion ?? "legacy",
      logCount: raw.logCount ?? logs.length,
      logStoreVersion: raw.logStoreVersion ?? 0,
      logs,
      createdAt: raw.createdAt ?? raw.updatedAt ?? new Date().toISOString(),
      updatedAt: raw.updatedAt ?? new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

export function readEtherscanCheckpoint(
  key: string
): EtherscanQueryCheckpoint | null {
  const manifest = readCheckpointManifest(key);
  if (manifest) {
    if (!isCompatibleManifest(manifest)) return null;
    const logs = readLogsFromStore(key);
    return manifestToCheckpoint(manifest, logs);
  }
  return readLegacyFlatCheckpoint(key);
}

export function readEtherscanCheckpointManifest(
  key: string
): CheckpointManifest | null {
  const manifest = readCheckpointManifest(key);
  if (manifest && isCompatibleManifest(manifest)) return manifest;
  const legacy = readLegacyFlatCheckpoint(key);
  if (!legacy || !isCompatibleCheckpoint(legacy)) return null;
  return migrateLegacyFlatCheckpoint({
    key: legacy.key,
    checkpointVersion: CHECKPOINT_SCHEMA_VERSION,
    queryPlanVersion: QUERY_PLAN_VERSION,
    identity: legacy.identity,
    completedRanges: legacy.completedRanges,
    highestCompletedBlock: legacy.highestCompletedBlock,
    logs: legacy.logs,
    requests: legacy.requests,
    pages: legacy.pages,
    errors: legacy.errors,
    createdAt: legacy.createdAt,
  });
}

/** @deprecated Use CheckpointLogSession.flush() — kept for tests migrating flat JSON. */
export function writeEtherscanCheckpoint(
  checkpoint: EtherscanQueryCheckpoint
): void {
  migrateLegacyFlatCheckpoint({
    key: checkpoint.key,
    checkpointVersion: checkpoint.checkpointVersion,
    queryPlanVersion: checkpoint.queryPlanVersion,
    identity: checkpoint.identity,
    completedRanges: checkpoint.completedRanges,
    highestCompletedBlock: checkpoint.highestCompletedBlock,
    logs: checkpoint.logs,
    requests: checkpoint.requests,
    pages: checkpoint.pages,
    errors: checkpoint.errors,
    createdAt: checkpoint.createdAt,
  });
  const legacyPath = checkpointPath(checkpoint.key);
  if (existsSync(legacyPath)) {
    try {
      unlinkSync(legacyPath);
    } catch {
      // best effort cleanup
    }
  }
}

export function clearEtherscanCheckpoint(key: string): void {
  const legacyPath = checkpointPath(key);
  if (existsSync(legacyPath)) {
    try {
      unlinkSync(legacyPath);
    } catch {
      // ignore
    }
  }
}

export function buildQueryCheckpointIdentity(
  input: QueryCheckpointIdentity
): string[] {
  return [
    String(CHECKPOINT_SCHEMA_VERSION),
    QUERY_PLAN_VERSION,
    input.providerId,
    input.chainId,
    input.wallet.toLowerCase(),
    input.contract.toLowerCase(),
    String(input.stableFromBlock),
    JSON.stringify(input.topics ?? []),
  ];
}

function inferQueryRoleTag(topicsJson: string | undefined): string {
  if (!topicsJson) return "unknown";
  try {
    const topics = JSON.parse(topicsJson) as unknown[];
    if (!Array.isArray(topics)) return "unknown";
    if (topics[3] != null) return "taker";
    if (topics[2] != null && topics[1] == null) return "maker";
    if (typeof topics[0] === "string") return topics[0].slice(2, 14);
    return "unknown";
  } catch {
    return "unknown";
  }
}

export function buildQueryCheckpointKey(
  identity: QueryCheckpointIdentity,
  schemaVersion: number = CHECKPOINT_SCHEMA_VERSION
): string {
  const parts = [
    String(schemaVersion),
    QUERY_PLAN_VERSION,
    identity.providerId,
    identity.chainId,
    identity.wallet.toLowerCase(),
    identity.contract.toLowerCase(),
    String(identity.stableFromBlock),
    JSON.stringify(identity.topics ?? []),
  ];
  const canonical = parts.join("|");
  const role = inferQueryRoleTag(parts[7]);
  const prefix = [
    parts[2],
    parts[4].slice(0, 10),
    parts[5].slice(0, 10),
    parts[6],
    role,
    `v${schemaVersion}`,
  ]
    .join("|")
    .replace(/[^a-zA-Z0-9_|.-]/g, "_")
    .slice(0, 120);
  const digest = createHash("sha256")
    .update(canonical)
    .digest("hex")
    .slice(0, 12);
  return `${prefix}_${digest}`;
}

function loadCheckpointByKey(
  key: string,
  options: { includeLogs?: boolean } = {}
): EtherscanQueryCheckpoint | null {
  const includeLogs = options.includeLogs !== false;
  const manifest = readCheckpointManifest(key);
  if (manifest && isCompatibleManifest(manifest)) {
    const logs = includeLogs ? readLogsFromStore(key) : [];
    return manifestToCheckpoint(manifest, logs);
  }
  const legacy = readLegacyFlatCheckpoint(key);
  if (!legacy) return null;
  if (!includeLogs) {
    return {
      ...legacy,
      logs: [],
      logCount: legacy.logCount ?? legacy.logs.length,
    };
  }
  if (legacy.logs.length === 0 && legacy.logCount === 0) return legacy;
  const migrated = migrateLegacyFlatCheckpoint({
    key,
    checkpointVersion: CHECKPOINT_SCHEMA_VERSION,
    queryPlanVersion: QUERY_PLAN_VERSION,
    identity: legacy.identity,
    completedRanges: legacy.completedRanges,
    highestCompletedBlock: legacy.highestCompletedBlock,
    logs: legacy.logs,
    requests: legacy.requests,
    pages: legacy.pages,
    errors: legacy.errors,
    createdAt: legacy.createdAt,
  });
  return manifestToCheckpoint(migrated, legacy.logs);
}

function isCompatibleManifest(manifest: CheckpointManifest): boolean {
  return (
    manifest.checkpointVersion === CHECKPOINT_SCHEMA_VERSION &&
    manifest.queryPlanVersion === QUERY_PLAN_VERSION &&
    manifest.logStoreVersion === CHECKPOINT_LOG_STORE_VERSION
  );
}

export function isCompatibleCheckpoint(
  checkpoint: EtherscanQueryCheckpoint
): boolean {
  return (
    checkpoint.checkpointVersion === CHECKPOINT_SCHEMA_VERSION &&
    checkpoint.queryPlanVersion === QUERY_PLAN_VERSION &&
    checkpoint.logStoreVersion === CHECKPOINT_LOG_STORE_VERSION
  );
}

/** @deprecated collision-prone 180-char keys from pre-v2 runs. */
export function buildLegacyQueryCheckpointKey(parts: string[]): string {
  return parts.join("|").replace(/[^a-zA-Z0-9_|.-]/g, "_").slice(0, 180);
}

/** Collision-safe v1 keys that still included toBlock in identity. */
function buildCollisionSafeV1CheckpointKey(parts: string[]): string {
  const canonical = parts.join("|");
  const role = inferQueryRoleTag(parts[5]);
  const prefix = [parts[0], parts[1], parts[2], parts[3], parts[4], role]
    .filter((part): part is string => Boolean(part))
    .join("|")
    .replace(/[^a-zA-Z0-9_|.-]/g, "_")
    .slice(0, 140);
  const digest = createHash("sha256")
    .update(canonical)
    .digest("hex")
    .slice(0, 12);
  return `${prefix}_${digest}`;
}

function migrateV1Checkpoint(
  identity: QueryCheckpointIdentity,
  raw: EtherscanQueryCheckpoint
): EtherscanQueryCheckpoint {
  const completedRanges = normalizeRanges(raw.completedRanges ?? []);
  const key = buildQueryCheckpointKey(identity);
  const manifest = migrateLegacyFlatCheckpoint({
    key,
    checkpointVersion: CHECKPOINT_SCHEMA_VERSION,
    queryPlanVersion: QUERY_PLAN_VERSION,
    identity,
    completedRanges,
    highestCompletedBlock: highestCompletedBlock(completedRanges),
    logs: raw.logs ?? [],
    requests: raw.requests,
    pages: raw.pages,
    errors: raw.errors,
    createdAt: raw.createdAt ?? raw.updatedAt ?? new Date().toISOString(),
  });
  auditLog(
    `[checkpoint-migrate] v1->v${CHECKPOINT_SCHEMA_VERSION} key=${key.slice(0, 80)} highest=${manifest.highestCompletedBlock}`
  );
  return manifestToCheckpoint(manifest, raw.logs ?? []);
}

function listCandidateToBlocks(identity: QueryCheckpointIdentity): number[] {
  if (!existsSync(LEGACY_CHECKPOINT_DIR)) return [];
  const blocks = new Set<number>();
  for (const name of readdirSync(LEGACY_CHECKPOINT_DIR)) {
    if (!name.endsWith(".json")) continue;
    if (!name.includes(identity.wallet.toLowerCase())) continue;
    if (!name.includes(identity.contract.toLowerCase())) continue;
    const match = name.match(/\|(\d+)\|(\d+)\|/);
    if (!match) continue;
    if (Number(match[1]) !== identity.stableFromBlock) continue;
    blocks.add(Number(match[2]));
  }
  return [...blocks].sort((a, b) => b - a);
}

function findMigratableV1Checkpoint(
  identity: QueryCheckpointIdentity
): EtherscanQueryCheckpoint | null {
  const topicsJson = JSON.stringify(identity.topics ?? []);
  const candidateKeys = new Set<string>();

  for (const toBlock of listCandidateToBlocks(identity)) {
    candidateKeys.add(
      buildCollisionSafeV1CheckpointKey([
        identity.providerId,
        identity.wallet,
        identity.contract,
        String(identity.stableFromBlock),
        String(toBlock),
        topicsJson,
      ])
    );
  }

  let best: EtherscanQueryCheckpoint | null = null;
  for (const key of candidateKeys) {
    const raw = readLegacyFlatCheckpoint(key);
    if (!raw) continue;
    const high =
      raw.highestCompletedBlock ?? highestCompletedBlock(raw.completedRanges) ?? -1;
    const bestHigh =
      best?.highestCompletedBlock ??
      highestCompletedBlock(best?.completedRanges ?? []) ??
      -1;
    if (high >= bestHigh) best = raw;
  }

  if (!best) return null;
  return migrateV1Checkpoint(identity, best);
}

export function readEtherscanCheckpointForIdentity(
  identity: QueryCheckpointIdentity,
  options: { includeLogs?: boolean } = {}
): EtherscanQueryCheckpoint | null {
  const canonicalKey = buildQueryCheckpointKey(identity, CHECKPOINT_SCHEMA_VERSION);
  ensureCanonicalCheckpointStore(
    canonicalKey,
    identity,
    CHECKPOINT_SCHEMA_VERSION,
    QUERY_PLAN_VERSION
  );

  for (const version of [CHECKPOINT_SCHEMA_VERSION, 2]) {
    const key = buildQueryCheckpointKey(identity, version);
    const loaded = loadCheckpointByKey(key, options);
    if (loaded) return loaded;
  }
  if (options.includeLogs === false) {
    return null;
  }
  return findMigratableV1Checkpoint(identity);
}

export function logCheckpointResume(input: {
  queryIndex: number;
  queryTotal: number;
  plan: CheckpointResumePlan;
  hit: boolean;
}): void {
  auditLog(
    [
      "[checkpoint-resume]",
      `query=${input.queryIndex}/${input.queryTotal}`,
      `hit=${input.hit}`,
      `covered=${formatBlockRanges(input.plan.reusedRanges)}`,
      `requested=${input.plan.requested.from}-${input.plan.requested.to}`,
      `reusedBlocks=${input.plan.reusedBlocks}`,
      `newBlocks=${input.plan.newBlocksToFetch}`,
      `uncoveredRanges=${input.plan.uncoveredRanges.length}`,
    ].join(" ")
  );
}

export {
  computeCheckpointResumePlan,
  formatBlockRanges,
  highestCompletedBlock,
  normalizeRanges,
  CHECKPOINT_STORE_DIR,
  type BlockRange,
  type CheckpointResumePlan,
};
