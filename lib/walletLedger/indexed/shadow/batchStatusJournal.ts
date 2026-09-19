import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/crossmarket/store/db";
import { walletShadowBatchStatus } from "@/lib/crossmarket/store/schema";
import { walletHistoryDbEnabled } from "@/lib/walletLedger/indexed/store/persistWalletHistory";
import { recordDbSuccess } from "@/lib/walletLedger/indexed/shadow/dbCircuitBreaker";
import {
  isEnospcFailedStatus,
  isLegacyInfraFailedStatus,
} from "@/lib/walletLedger/indexed/shadow/infraClassification";
import { retryTransient } from "@/lib/walletLedger/indexed/shadow/transientRetry";

export const SHADOW_STATUS_JOURNAL_DIR = join(
  process.cwd(),
  "tmp",
  "wallet-history",
  "shadow-compare"
);

export const SHADOW_STATUS_JOURNAL_FILE = join(
  SHADOW_STATUS_JOURNAL_DIR,
  "phase2e1-full50-v2-status-journal.jsonl"
);

export type ShadowBatchWalletStatus =
  | "pending"
  | "running"
  | "complete"
  | "unusable"
  | "wallet_failed"
  | "internal_error"
  | "deferred_infra"
  | "failed";

export const TERMINAL_BATCH_STATUSES = new Set<ShadowBatchWalletStatus>([
  "complete",
  "unusable",
  "wallet_failed",
  "internal_error",
]);

function formatPersistError(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current != null; depth += 1) {
    if (current instanceof Error) {
      parts.push(current.message);
      const meta = current as Error & {
        code?: string;
        severity?: string;
        detail?: string;
        hint?: string;
      };
      if (meta.code) parts.push(`code=${meta.code}`);
      if (meta.severity) parts.push(`severity=${meta.severity}`);
      if (meta.detail) parts.push(`detail=${meta.detail}`);
      if (meta.hint) parts.push(`hint=${meta.hint}`);
      current = meta.cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  return parts.join(" | ");
}

export function normalizeJournalDesiredStatus(status: string): string {
  if (status === "failed") return "deferred_infra";
  return status;
}

export interface ShadowBatchStatusJournalEntry {
  batchId: string;
  wallet: string;
  desiredStatus: string;
  error?: string;
  performance?: Record<string, unknown>;
  timestamp: string;
  cohortReason?: string;
  errorMessage?: string;
}

export interface UpsertBatchStatusInput {
  batchId: string;
  wallet: string;
  status: string;
  cohortReason?: string;
  errorMessage?: string;
  performance?: Record<string, unknown>;
}

function ensureJournalDir(): void {
  if (!existsSync(SHADOW_STATUS_JOURNAL_DIR)) {
    mkdirSync(SHADOW_STATUS_JOURNAL_DIR, { recursive: true });
  }
}

export function appendBatchStatusJournal(
  entry: ShadowBatchStatusJournalEntry
): void {
  ensureJournalDir();
  appendFileSync(SHADOW_STATUS_JOURNAL_FILE, `${JSON.stringify(entry)}\n`, "utf8");
}

async function upsertBatchStatusOnce(input: UpsertBatchStatusInput): Promise<void> {
  if (!walletHistoryDbEnabled()) return;
  const db = getDb();
  await db
    .insert(walletShadowBatchStatus)
    .values({
      batchId: input.batchId,
      walletAddress: input.wallet.toLowerCase(),
      status: input.status,
      cohortReason: input.cohortReason ?? null,
      errorMessage: input.errorMessage?.slice(0, 2000) ?? null,
      performance: input.performance ?? null,
    })
    .onConflictDoUpdate({
      target: [
        walletShadowBatchStatus.batchId,
        walletShadowBatchStatus.walletAddress,
      ],
      set: {
        status: input.status,
        cohortReason: input.cohortReason ?? null,
        errorMessage: input.errorMessage?.slice(0, 2000) ?? null,
        performance: input.performance ?? null,
        updatedAt: new Date(),
      },
    });
}

/**
 * Retries transient Neon/network failures; journals locally if DB stays unavailable.
 * Never throws — batch processing must continue.
 */
export async function upsertBatchStatusSafe(
  input: UpsertBatchStatusInput
): Promise<{ persisted: boolean; journaled: boolean }> {
  try {
    await retryTransient(() => upsertBatchStatusOnce(input), {
      maxAttempts: 4,
      label: "upsertBatchStatus",
    });
    recordDbSuccess();
    return { persisted: true, journaled: false };
  } catch (error) {
    const message = formatPersistError(error);
    appendBatchStatusJournal({
      batchId: input.batchId,
      wallet: input.wallet.toLowerCase(),
      desiredStatus: input.status,
      error: message,
      performance: input.performance,
      timestamp: new Date().toISOString(),
      cohortReason: input.cohortReason,
      errorMessage: input.errorMessage,
    });
    console.warn(
      `[shadow-batch] status journal fallback batch=${input.batchId} wallet=${input.wallet} status=${input.status}: ${message}`
    );
    return { persisted: false, journaled: true };
  }
}

export function readBatchStatusJournal(): ShadowBatchStatusJournalEntry[] {
  if (!existsSync(SHADOW_STATUS_JOURNAL_FILE)) return [];
  return readFileSync(SHADOW_STATUS_JOURNAL_FILE, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ShadowBatchStatusJournalEntry);
}

export async function reconcileBatchStatusJournal(
  batchId?: string
): Promise<{ reconciled: number; failed: number }> {
  if (!walletHistoryDbEnabled()) return { reconciled: 0, failed: 0 };
  const entries = readBatchStatusJournal().filter(
    (entry) => !batchId || entry.batchId === batchId
  );
  let reconciled = 0;
  let failed = 0;
  for (const entry of entries) {
    const desiredStatus = normalizeJournalDesiredStatus(entry.desiredStatus);
    const result = await upsertBatchStatusSafe({
      batchId: entry.batchId,
      wallet: entry.wallet,
      status: desiredStatus,
      cohortReason: entry.cohortReason,
      errorMessage: entry.errorMessage ?? entry.error,
      performance: entry.performance,
    });
    if (result.persisted) reconciled += 1;
    else failed += 1;
  }
  return { reconciled, failed };
}

/** Crash recovery: stale `running` rows from a prior process become retryable. */
export async function resetStaleRunningBatchWallets(
  batchId: string
): Promise<number> {
  if (!walletHistoryDbEnabled()) return 0;
  const db = getDb();
  const result = await db
    .update(walletShadowBatchStatus)
    .set({
      status: "pending",
      errorMessage: "stale_running_reset_on_resume",
      updatedAt: new Date(),
    })
    .where(
      sql`${walletShadowBatchStatus.batchId} = ${batchId} AND ${walletShadowBatchStatus.status} = 'running'`
    )
    .returning({ walletAddress: walletShadowBatchStatus.walletAddress });
  if (result.length > 0) {
    console.error(
      `[shadow-batch] reset stale running wallets batchId=${batchId} count=${result.length}`
    );
  }
  return result.length;
}

/** Reclassify wallet_failed rows caused by ENOSPC / disk exhaustion. */
export async function reclassifyEnospcBatchStatuses(
  batchId: string
): Promise<number> {
  if (!walletHistoryDbEnabled()) return 0;
  const db = getDb();
  const rows = await db
    .select()
    .from(walletShadowBatchStatus)
    .where(sql`${walletShadowBatchStatus.batchId} = ${batchId}`);
  let changed = 0;
  for (const row of rows) {
    if (
      !isEnospcFailedStatus({
        status: row.status,
        errorMessage: row.errorMessage,
      })
    ) {
      continue;
    }
    await upsertBatchStatusSafe({
      batchId,
      wallet: row.walletAddress,
      status: "deferred_infra",
      cohortReason: row.cohortReason ?? undefined,
      errorMessage: row.errorMessage ?? "reclassified_enospc_failure",
    });
    changed += 1;
  }
  return changed;
}

/** Reclassify infra `failed` rows poisoned during Neon/provider outages. */
export async function reclassifyInfraFailedBatchStatuses(
  batchId: string
): Promise<number> {
  if (!walletHistoryDbEnabled()) return 0;
  const db = getDb();
  const rows = await db
    .select()
    .from(walletShadowBatchStatus)
    .where(sql`${walletShadowBatchStatus.batchId} = ${batchId}`);
  let changed = 0;
  for (const row of rows) {
    if (
      !isLegacyInfraFailedStatus({
        status: row.status,
        errorMessage: row.errorMessage,
      })
    ) {
      continue;
    }
    await upsertBatchStatusSafe({
      batchId,
      wallet: row.walletAddress,
      status: "deferred_infra",
      cohortReason: row.cohortReason ?? undefined,
      errorMessage: row.errorMessage ?? "reclassified_infra_failure",
    });
    changed += 1;
  }
  return changed;
}

export async function loadWalletBatchStatus(
  batchId: string,
  wallet: string
): Promise<typeof walletShadowBatchStatus.$inferSelect | null> {
  if (!walletHistoryDbEnabled()) return null;
  const db = getDb();
  const rows = await db
    .select()
    .from(walletShadowBatchStatus)
    .where(
      sql`${walletShadowBatchStatus.batchId} = ${batchId} AND ${walletShadowBatchStatus.walletAddress} = ${wallet.toLowerCase()}`
    )
    .limit(1);
  return rows[0] ?? null;
}

export function summarizeJournalStatuses(
  batchId: string
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of readBatchStatusJournal()) {
    if (entry.batchId !== batchId) continue;
    const status = normalizeJournalDesiredStatus(entry.desiredStatus);
    counts[status] = (counts[status] ?? 0) + 1;
  }
  return counts;
}
