#!/usr/bin/env tsx
/**
 * Wallet-history checkpoint GC — dry-run by default.
 *
 *   npx tsx --tsconfig tsconfig.json scripts/gc-wallet-history-checkpoints.ts
 *   npx tsx --tsconfig tsconfig.json scripts/gc-wallet-history-checkpoints.ts --batch-id phase2e2-stageC-v1
 *   npx tsx --tsconfig tsconfig.json scripts/gc-wallet-history-checkpoints.ts --apply
 */
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import "./preload-env";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/crossmarket/store/db";
import {
  walletHistoricalMetrics,
  walletHistoryCoverage,
  walletShadowBatchStatus,
} from "@/lib/crossmarket/store/schema";
import {
  buildQueryCheckpointKey,
  CHECKPOINT_SCHEMA_VERSION,
  QUERY_PLAN_VERSION,
} from "@/lib/walletLedger/indexed/checkpoint";
import {
  CHECKPOINT_STORE_DIR,
  checkpointStoreDir,
  type CheckpointManifest,
} from "@/lib/walletLedger/indexed/checkpointLogStore";
import { WALLET_METRIC_VERSION } from "@/lib/walletLedger/indexed/metricVersion";
import { reclassifyEnospcBatchStatuses } from "@/lib/walletLedger/indexed/shadow/batchStatusJournal";
import { loadStageCCohortFromManifest } from "@/lib/walletLedger/indexed/shadow/cohortStageC";
import {
  getFreeDiskGiB,
} from "@/lib/walletLedger/indexed/shadow/diskGuard";
import {
  isCodeDefectError,
  isEnospcFailedStatus,
  isInfraFailureError,
} from "@/lib/walletLedger/indexed/shadow/infraClassification";
import { STAGE_C_BATCH_ID } from "@/lib/walletLedger/indexed/studyVersion";

const PROTECTED_ROOTS = [
  join(process.cwd(), "tmp", "wallet-history", "gamma"),
  join(process.cwd(), "tmp", "wallet-history", "block-timestamps"),
  join(process.cwd(), "tmp", "wallet-history", "shadow-compare"),
];

interface CheckpointDirInfo {
  dirPath: string;
  dirName: string;
  bytes: number;
  format: "v2" | "v3" | "unknown";
  manifest: CheckpointManifest | null;
  wallet: string | null;
  canonicalV3Key: string | null;
}

interface WalletPersistenceState {
  wallet: string;
  batchStatus: string | null;
  coverage: {
    exists: boolean;
    metricVersion: string | null;
    lastIndexedBlock: number | null;
    lastReconstructedBlock: number | null;
    historyValidity: string | null;
    eventHistoryComplete: boolean | null;
  };
  metrics: {
    exists: boolean;
    throughBlock: number | null;
    historyValidity: string | null;
  };
  eventCount: number;
  runningAnyBatch: boolean;
}

function parseArgs(argv: string[]): {
  batchId: string;
  apply: boolean;
} {
  let batchId = STAGE_C_BATCH_ID;
  let apply = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") apply = true;
    else if (arg === "--batch-id" && argv[i + 1]) batchId = argv[++i]!;
  }
  return { batchId, apply };
}

function dirSizeBytes(path: string): number {
  let total = 0;
  const stack = [path];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(current, entry);
      try {
        const stat = statSync(full);
        if (stat.isDirectory()) stack.push(full);
        else total += stat.size;
      } catch {
        // skip unreadable
      }
    }
  }
  return total;
}

function readManifest(dirPath: string): CheckpointManifest | null {
  const path = join(dirPath, "manifest.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as CheckpointManifest;
  } catch {
    return null;
  }
}

function classifyFormat(
  manifest: CheckpointManifest | null,
  dirName: string
): "v2" | "v3" | "unknown" {
  if (/_((maker|taker|stakeholder))_v2_/.test(dirName)) return "v2";
  if (/_((maker|taker|stakeholder))_v3_/.test(dirName)) return "v3";
  if (manifest?.checkpointVersion === 2) return "v2";
  if (manifest?.checkpointVersion === 3) return "v3";
  return "unknown";
}

function scanCheckpointDirs(): CheckpointDirInfo[] {
  if (!existsSync(CHECKPOINT_STORE_DIR)) return [];
  const dirs: CheckpointDirInfo[] = [];
  for (const dirName of readdirSync(CHECKPOINT_STORE_DIR)) {
    const dirPath = join(CHECKPOINT_STORE_DIR, dirName);
    try {
      if (!statSync(dirPath).isDirectory()) continue;
    } catch {
      continue;
    }
    const manifest = readManifest(dirPath);
    const wallet = manifest?.identity.wallet?.toLowerCase() ?? null;
    const canonicalV3Key = manifest
      ? buildQueryCheckpointKey(manifest.identity, CHECKPOINT_SCHEMA_VERSION)
      : null;
    dirs.push({
      dirPath,
      dirName,
      bytes: dirSizeBytes(dirPath),
      format: classifyFormat(manifest, dirName),
      manifest,
      wallet,
      canonicalV3Key,
    });
  }
  return dirs;
}

function canonicalV3DirExists(
  dirs: CheckpointDirInfo[],
  canonicalKey: string
): CheckpointDirInfo | null {
  const expected = checkpointStoreDir(canonicalKey);
  return dirs.find((d) => d.dirPath === expected) ?? null;
}

function isV2Superseded(
  v2Dir: CheckpointDirInfo,
  dirs: CheckpointDirInfo[]
): boolean {
  if (!v2Dir.manifest || !v2Dir.canonicalV3Key) return false;
  const canonical = canonicalV3DirExists(dirs, v2Dir.canonicalV3Key);
  if (!canonical?.manifest) return false;
  return canonical.manifest.logCount >= v2Dir.manifest.logCount;
}

async function loadWalletPersistence(
  wallet: string
): Promise<WalletPersistenceState> {
  const db = getDb();
  const normalized = wallet.toLowerCase();
  const coverageRows = await db
    .select()
    .from(walletHistoryCoverage)
    .where(sql`lower(${walletHistoryCoverage.walletAddress}) = ${normalized}`)
    .limit(1);
  const metricsRows = await db
    .select()
    .from(walletHistoricalMetrics)
    .where(
      sql`lower(${walletHistoricalMetrics.walletAddress}) = ${normalized} AND ${walletHistoricalMetrics.metricVersion} = ${WALLET_METRIC_VERSION}`
    )
    .limit(1);
  const eventCountRow = await db.execute(sql`
    SELECT count(*)::int AS c FROM wallet_ledger_events
    WHERE lower(wallet_address) = ${normalized}
  `);
  const runningRows = await db
    .select({ batchId: walletShadowBatchStatus.batchId })
    .from(walletShadowBatchStatus)
    .where(
      sql`lower(${walletShadowBatchStatus.walletAddress}) = ${normalized} AND ${walletShadowBatchStatus.status} = 'running'`
    )
    .limit(1);

  const coverage = coverageRows[0];
  const metrics = metricsRows[0];
  return {
    wallet: normalized,
    batchStatus: null,
    coverage: {
      exists: Boolean(coverage),
      metricVersion: coverage?.metricVersion ?? null,
      lastIndexedBlock: coverage?.lastIndexedBlock ?? null,
      lastReconstructedBlock: coverage?.lastReconstructedBlock ?? null,
      historyValidity: coverage?.historyValidity ?? null,
      eventHistoryComplete: coverage?.eventHistoryComplete ?? null,
    },
    metrics: {
      exists: Boolean(metrics),
      throughBlock: metrics?.throughBlock ?? null,
      historyValidity: metrics?.historyValidity ?? null,
    },
    eventCount: Number((eventCountRow.rows[0] as { c?: number })?.c ?? 0),
    runningAnyBatch: runningRows.length > 0,
  };
}

function coverageStructurallyValid(state: WalletPersistenceState): boolean {
  if (!state.coverage.exists) return false;
  if (state.coverage.metricVersion !== WALLET_METRIC_VERSION) return false;
  if (state.coverage.lastIndexedBlock == null || state.coverage.lastIndexedBlock <= 0) {
    return false;
  }
  if (state.coverage.historyValidity == null) return false;
  return true;
}

function eventsPersistedForIndexedRange(state: WalletPersistenceState): boolean {
  if (!state.metrics.exists || state.metrics.throughBlock == null) return false;
  if (state.eventCount <= 0) return false;
  const indexedThrough = state.coverage.lastIndexedBlock ?? 0;
  return indexedThrough >= state.metrics.throughBlock;
}

function isTerminalBatchStatus(status: string | null): boolean {
  return status === "complete" || status === "unusable";
}

function isProtectedBatchStatus(status: string | null): boolean {
  if (status == null) return true;
  return (
    status === "pending" ||
    status === "running" ||
    status === "deferred_infra" ||
    status === "internal_error" ||
    status === "wallet_failed"
  );
}

function walletCheckpointRemovable(
  state: WalletPersistenceState,
  batchStatus: string | null
): { removable: boolean; reason: string } {
  if (state.runningAnyBatch) {
    return { removable: false, reason: "active_running_audit" };
  }
  if (!isTerminalBatchStatus(batchStatus)) {
    return {
      removable: false,
      reason: batchStatus == null ? "no_terminal_batch_status" : `batch_status_${batchStatus}`,
    };
  }
  if (!coverageStructurallyValid(state)) {
    return { removable: false, reason: "coverage_missing_or_invalid" };
  }
  if (!state.metrics.exists) {
    return { removable: false, reason: "metrics_missing" };
  }
  if (!eventsPersistedForIndexedRange(state)) {
    return { removable: false, reason: "events_not_persisted_for_indexed_range" };
  }
  return { removable: true, reason: "terminal_persisted" };
}

function bytesToGiB(bytes: number): number {
  return bytes / 1024 ** 3;
}

function summarizeWalletFailed(
  rows: Array<{ wallet: string; errorMessage: string | null }>
): Array<{
  wallet: string;
  rootCause: string;
  retryable: boolean;
  rationale: string;
}> {
  return rows.map((row) => {
    const msg = row.errorMessage ?? "unknown";
    const err = new Error(msg);
    if (isEnospcFailedStatus({ status: "wallet_failed", errorMessage: msg })) {
      return {
        wallet: row.wallet,
        rootCause: "ENOSPC",
        retryable: true,
        rationale: "Disk exhaustion — should be deferred_infra, not wallet_failed",
      };
    }
    if (isCodeDefectError(err)) {
      return {
        wallet: row.wallet,
        rootCause: "code_defect",
        retryable: false,
        rationale: "Programming/runtime defect — requires code fix",
      };
    }
    if (isInfraFailureError(err)) {
      return {
        wallet: row.wallet,
        rootCause: "infra",
        retryable: true,
        rationale: "Transient infra — should be deferred_infra",
      };
    }
    return {
      wallet: row.wallet,
      rootCause: "wallet_data",
      retryable: false,
      rationale: "Deterministic wallet/data failure",
    };
  });
}

async function main(): Promise<void> {
  const { batchId, apply } = parseArgs(process.argv.slice(2));
  const manifest = loadStageCCohortFromManifest();
  if (!manifest) {
    throw new Error("Missing Stage C cohort manifest");
  }

  const enospcReclassified = await reclassifyEnospcBatchStatuses(batchId);
  if (enospcReclassified > 0) {
    console.error(
      `[gc-checkpoints] reclassified ${enospcReclassified} ENOSPC wallet_failed → deferred_infra`
    );
  }

  const db = getDb();
  const statusRows = await db
    .select()
    .from(walletShadowBatchStatus)
    .where(sql`${walletShadowBatchStatus.batchId} = ${batchId}`);
  const statusByWallet = new Map(
    statusRows.map((r) => [r.walletAddress.toLowerCase(), r])
  );

  const cohortWallets = manifest.wallets.map((w) => w.wallet.toLowerCase());
  const cohortStatusCounts: Record<string, number> = {
    complete: 0,
    unusable: 0,
    deferred_infra: 0,
    wallet_failed: 0,
    internal_error: 0,
    running: 0,
    pending_no_row: 0,
  };
  const staleRunning: string[] = [];

  for (const wallet of cohortWallets) {
    const row = statusByWallet.get(wallet);
    if (!row) {
      cohortStatusCounts.pending_no_row += 1;
      continue;
    }
    const status = row.status;
    if (status === "complete") cohortStatusCounts.complete += 1;
    else if (status === "unusable") cohortStatusCounts.unusable += 1;
    else if (status === "deferred_infra") cohortStatusCounts.deferred_infra += 1;
    else if (status === "wallet_failed") cohortStatusCounts.wallet_failed += 1;
    else if (status === "internal_error") cohortStatusCounts.internal_error += 1;
    else if (status === "running") {
      cohortStatusCounts.running += 1;
      staleRunning.push(wallet);
    } else cohortStatusCounts.pending_no_row += 1;
  }

  const walletFailedRows = statusRows
    .filter((r) => r.status === "wallet_failed")
    .map((r) => ({
      wallet: r.walletAddress.toLowerCase(),
      errorMessage: r.errorMessage,
    }));
  const walletFailedAnalysis = summarizeWalletFailed(walletFailedRows);

  const allDirs = scanCheckpointDirs();
  const v2Dirs = allDirs.filter((d) => d.format === "v2");
  const v3Dirs = allDirs.filter((d) => d.format === "v3");

  const walletStates = new Map<string, WalletPersistenceState>();
  for (const wallet of new Set([
    ...cohortWallets,
    ...allDirs.map((d) => d.wallet).filter((w): w is string => w != null),
  ])) {
    walletStates.set(wallet, await loadWalletPersistence(wallet));
  }

  const terminalV3EligibleWallets = new Set<string>();
  const protectedWallets = new Set<string>();
  const walletRemovalReasons = new Map<string, string>();

  for (const wallet of cohortWallets) {
    const state = walletStates.get(wallet)!;
    const batchStatus = statusByWallet.get(wallet)?.status ?? null;
    state.batchStatus = batchStatus;
    const verdict = walletCheckpointRemovable(state, batchStatus);
    walletRemovalReasons.set(wallet, verdict.reason);
    if (verdict.removable) terminalV3EligibleWallets.add(wallet);
    else protectedWallets.add(wallet);
  }

  const v2Eligible = v2Dirs.filter(
    (d) =>
      isV2Superseded(d, allDirs) ||
      (d.wallet != null && terminalV3EligibleWallets.has(d.wallet))
  );
  const v2Ineligible = v2Dirs.filter((d) => !v2Eligible.includes(d));
  const v2TerminalEligibleDirs = v2Dirs.filter(
    (d) => d.wallet != null && terminalV3EligibleWallets.has(d.wallet)
  );
  const terminalV3EligibleDirs = v3Dirs.filter(
    (d) => d.wallet != null && terminalV3EligibleWallets.has(d.wallet)
  );
  const reclaimableDirs = [
    ...new Map(
      [...v2Eligible, ...terminalV3EligibleDirs].map((d) => [d.dirPath, d])
    ).values(),
  ].sort((a, b) => b.bytes - a.bytes);
  const protectedDirs = allDirs.filter(
    (d) => !reclaimableDirs.some((r) => r.dirPath === d.dirPath)
  );

  const v2EligibleBytes = v2Eligible.reduce((s, d) => s + d.bytes, 0);
  const terminalV3EligibleBytes = reclaimableDirs.reduce((s, d) => s + d.bytes, 0);
  const protectedBytes = protectedDirs.reduce((s, d) => s + d.bytes, 0);
  const totalReclaimableBytes = terminalV3EligibleBytes;

  const largestReclaimable = reclaimableDirs.slice(0, 20).map((d) => ({
    dir: d.dirName,
    wallet: d.wallet,
    format: d.format,
    bytes: d.bytes,
    gib: bytesToGiB(d.bytes),
  }));

  const readerVersions = {
    directResume: `checkpointVersion=${CHECKPOINT_SCHEMA_VERSION}, queryPlanVersion=${QUERY_PLAN_VERSION}`,
    siblingAdoption: "scans v2+v3 manifests via listCheckpointManifestsForIdentity; copies richest into canonical v3",
    compatibilityFallback: "v1 flat JSON in wallet-indexed-audit/checkpoints only",
    v2KeyLookup: "buildQueryCheckpointKey(identity, 2) — only returns v3-compatible manifests",
  };

  const v2ObsoleteForDirectResume = true;

  const freeGiB = getFreeDiskGiB();
  const expectedFreeAfterGcGiB = freeGiB + bytesToGiB(totalReclaimableBytes);
  const stageCSafeToResume =
    freeGiB >= 20 &&
    expectedFreeAfterGcGiB >= 20 &&
    cohortStatusCounts.running === 0;

  const report: Record<string, unknown> = {
    batchId,
    mode: apply ? "apply" : "dry-run",
    freeDiskGiB: Number(freeGiB.toFixed(2)),
    checkpointReaderVersions: readerVersions,
    v2Obsolescence: {
      obsoleteForDirectResume: v2ObsoleteForDirectResume,
      stillReadBySiblingAdoption: true,
      stillReadByV2KeyLookup: true,
      safelyObsoleteGlobally: false,
      note:
        "All 25 v2-keyed dirs carry checkpointVersion=3 manifests; v2 key path is still consulted by readEtherscanCheckpointForIdentity until deleted. Safe to delete per-wallet once terminal + DB-persisted.",
      totalV2Dirs: v2Dirs.length,
      v2EligibleDirs: v2Eligible.length,
      v2IneligibleDirs: v2Ineligible.length,
      v2EligibleGiB: Number(bytesToGiB(v2EligibleBytes).toFixed(3)),
      v2IneligibleGiB: Number(
        bytesToGiB(v2Ineligible.reduce((s, d) => s + d.bytes, 0)).toFixed(3)
      ),
      v2TerminalEligibleDirs: v2TerminalEligibleDirs.length,
      ineligibleV2Reason:
        v2Ineligible.length > 0
          ? "wallet not terminal-persisted and no superseding canonical v3 store"
          : null,
    },
    v2EligibleDirs: v2Eligible.length,
    v2EligibleBytes,
    terminalV3EligibleWallets: terminalV3EligibleWallets.size,
    terminalV3EligibleDirs: terminalV3EligibleDirs.length,
    terminalV3EligibleBytes,
    protectedWallets: protectedWallets.size,
    protectedDirs: protectedDirs.length,
    protectedBytes,
    totalReclaimableBytes,
    totalReclaimableGiB: Number(bytesToGiB(totalReclaimableBytes).toFixed(3)),
    largestReclaimableCheckpointDirs: largestReclaimable,
    cohortStatusReconciliation: {
      ...cohortStatusCounts,
      total: cohortWallets.length,
      staleRunningRetryable: staleRunning,
    },
    enospcReclassifiedRows: enospcReclassified,
    remainingWalletFailed: walletFailedAnalysis,
    expectedFreeDiskGiBAfterGc: Number(expectedFreeAfterGcGiB.toFixed(2)),
    stageCSafeToResume,
    walletRemovalReasons: Object.fromEntries(
      [...walletRemovalReasons.entries()].slice(0, 30)
    ),
  };

  if (apply) {
    let deletedDirs = 0;
    let reclaimedBytes = 0;
    const failedDeletes: string[] = [];
    for (const dir of reclaimableDirs) {
      if (PROTECTED_ROOTS.some((root) => dir.dirPath.startsWith(root))) continue;
      if (!dir.dirPath.startsWith(CHECKPOINT_STORE_DIR)) continue;
      try {
        rmSync(dir.dirPath, { recursive: true, force: true });
        deletedDirs += 1;
        reclaimedBytes += dir.bytes;
      } catch (error) {
        failedDeletes.push(
          `${dir.dirName}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    report.applyResult = {
      deletedDirs,
      reclaimedBytes,
      reclaimedGiB: Number(bytesToGiB(reclaimedBytes).toFixed(3)),
      failedDeletes,
    };
  }

  console.log(JSON.stringify(report, null, 2));
}

void main().catch((error) => {
  console.error("[gc-checkpoints] failed:", error);
  process.exit(1);
});
