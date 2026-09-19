#!/usr/bin/env tsx
/**
 * Canonical identity DB migration for pilot wallet(s).
 * Run ONLY after canonical-v2 cold/resume gate passes.
 *
 * Steps: add column → backfill → collapse duplicates → unique partial index → verify.
 */
import "../tests/preload-env";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { buildCanonicalChainLogIdentity } from "@/lib/walletLedger/canonicalChainIdentity";
import { getDb } from "@/lib/crossmarket/store/db";
import { walletLedgerEvents } from "@/lib/crossmarket/store/schema";

const WALLET = (
  process.env.ONLY_WALLET ?? "0x4f29e103339919c4baaea2a60195cf1c8bb27a7e"
).toLowerCase();
const GATE_FILE = path.join(
  process.cwd(),
  ".cache",
  "4f29-canonical-v2-cold-resume.json"
);
const BATCH_SIZE = 5_000;

interface RowSlice {
  id: number;
  dedupe_key: string;
  canonical_identity: string | null;
  tx_hash: string | null;
  log_index: string | null;
  block_number: number | null;
  block_timestamp: number | null;
  event_type: string;
  asset_id: string | null;
  shares: number | null;
  cash_usd: number | null;
  price: number | null;
}

function deriveCanonical(row: RowSlice): string | null {
  if (!row.tx_hash || row.log_index == null || row.log_index === "") {
    return null;
  }
  const logIndex = Number.parseInt(row.log_index, 10);
  if (!Number.isFinite(logIndex) || logIndex < 0) return null;
  return buildCanonicalChainLogIdentity({ txHash: row.tx_hash, logIndex });
}

function economicKey(row: RowSlice): string {
  return [
    row.event_type,
    row.asset_id ?? "",
    row.shares?.toFixed(6) ?? "",
    row.cash_usd?.toFixed(6) ?? "",
    row.price?.toFixed(6) ?? "",
  ].join("|");
}

function pickSurvivor(group: RowSlice[]): RowSlice {
  return [...group].sort((a, b) => a.id - b.id)[0]!;
}

function mergeMetadata(survivor: RowSlice, row: RowSlice): Partial<RowSlice> {
  const patch: Partial<RowSlice> = {};
  if ((survivor.block_number ?? 0) <= 0 && (row.block_number ?? 0) > 0) {
    patch.block_number = row.block_number;
  }
  if ((survivor.block_timestamp ?? 0) <= 0 && (row.block_timestamp ?? 0) > 0) {
    patch.block_timestamp = row.block_timestamp;
  }
  if (
    (survivor.log_index == null || survivor.log_index === "") &&
    row.log_index
  ) {
    patch.log_index = row.log_index;
  }
  if (!survivor.tx_hash && row.tx_hash) {
    patch.tx_hash = row.tx_hash;
  }
  return patch;
}

async function assertGatePassed(): Promise<void> {
  const raw = await readFile(GATE_FILE, "utf8");
  const gate = JSON.parse(raw) as { gatePass?: boolean };
  if (!gate.gatePass) {
    throw new Error(
      `canonical-v2 cold/resume gate has not passed (${GATE_FILE})`
    );
  }
}

async function applySchemaMigration(db: ReturnType<typeof getDb>): Promise<void> {
  await db.execute(sql`
    ALTER TABLE wallet_ledger_events
      ADD COLUMN IF NOT EXISTS canonical_identity text
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS wallet_ledger_events_wallet_canonical_idx
      ON wallet_ledger_events (wallet_address, canonical_identity)
      WHERE canonical_identity IS NOT NULL
  `);
}

async function backfillCanonicalIdentity(
  db: ReturnType<typeof getDb>
): Promise<number> {
  const result = await db.execute(sql`
    UPDATE wallet_ledger_events
    SET canonical_identity = 'chain|137|' || lower(tx_hash) || '|' || log_index,
        updated_at = NOW()
    WHERE wallet_address = ${WALLET}
      AND canonical_identity IS NULL
      AND tx_hash IS NOT NULL
      AND log_index IS NOT NULL
      AND log_index <> ''
      AND log_index ~ '^[0-9]+$'
  `);
  const updated = Number((result as { rowCount?: number }).rowCount ?? 0);
  console.error(`[migration] backfilled rows=${updated}`);
  return updated;
}

async function loadCanonicalRowsPaginated(
  db: ReturnType<typeof getDb>
): Promise<RowSlice[]> {
  const allRows: RowSlice[] = [];
  let cursorId = 0;
  while (true) {
    const page = await db.execute<RowSlice>(sql`
      SELECT
        id, dedupe_key, canonical_identity, tx_hash, log_index,
        block_number, block_timestamp, event_type, asset_id, shares, cash_usd, price
      FROM wallet_ledger_events
      WHERE wallet_address = ${WALLET}
        AND canonical_identity IS NOT NULL
        AND id > ${cursorId}
      ORDER BY id ASC
      LIMIT ${BATCH_SIZE}
    `);
    const batch = page.rows as RowSlice[];
    if (batch.length === 0) break;
    allRows.push(...batch);
    cursorId = batch[batch.length - 1]!.id;
    if (batch.length < BATCH_SIZE) break;
  }
  return allRows;
}

async function collapseDuplicates(
  db: ReturnType<typeof getDb>
): Promise<{ deleted: number; economicConflicts: number }> {
  const allRows = await loadCanonicalRowsPaginated(db);
  const groups = new Map<string, RowSlice[]>();
  for (const row of allRows) {
    const key = row.canonical_identity!;
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }

  let deleted = 0;
  let economicConflicts = 0;
  for (const [, group] of groups) {
    if (group.length <= 1) continue;
    const economicKeys = [...new Set(group.map(economicKey))];
    if (economicKeys.length > 1) {
      economicConflicts += 1;
      continue;
    }
    const survivor = pickSurvivor(group);
    const duplicates = group.filter((row) => row.id !== survivor.id);
    let patch = { ...survivor };
    for (const row of duplicates) {
      patch = { ...patch, ...mergeMetadata(patch, row) };
    }
    await db
      .update(walletLedgerEvents)
      .set({
        blockNumber: patch.block_number,
        blockTimestamp: patch.block_timestamp,
        logIndex: patch.log_index,
        txHash: patch.tx_hash,
        updatedAt: new Date(),
      })
      .where(eq(walletLedgerEvents.id, survivor.id));
    const duplicateIds = duplicates.map((row) => row.id);
    if (duplicateIds.length > 0) {
      await db
        .delete(walletLedgerEvents)
        .where(inArray(walletLedgerEvents.id, duplicateIds));
      deleted += duplicateIds.length;
    }
  }
  return { deleted, economicConflicts };
}

async function createUniquePartialIndex(db: ReturnType<typeof getDb>): Promise<void> {
  await db.execute(sql`
    DROP INDEX IF EXISTS wallet_ledger_events_canonical_identity_unique
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS wallet_ledger_events_wallet_canonical_unique
      ON wallet_ledger_events (wallet_address, canonical_identity)
      WHERE canonical_identity IS NOT NULL
  `);
}

async function postMigrationReport(db: ReturnType<typeof getDb>) {
  const counts = await db.execute(sql`
    SELECT
      count(*)::int AS total_rows,
      count(canonical_identity)::int AS with_canonical,
      count(DISTINCT canonical_identity)::int AS unique_canonical
    FROM wallet_ledger_events
    WHERE wallet_address = ${WALLET}
  `);
  const dupGroups = await db.execute(sql`
    SELECT canonical_identity, count(*)::int AS c
    FROM wallet_ledger_events
    WHERE wallet_address = ${WALLET}
      AND canonical_identity IS NOT NULL
    GROUP BY canonical_identity
    HAVING count(*) > 1
  `);
  const row = counts.rows[0] as {
    total_rows: number;
    with_canonical: number;
    unique_canonical: number;
  };
  const duplicateGroupsRemaining = (dupGroups.rows as unknown[]).length;
  return {
    wallet: WALLET,
    rowsAfterCollapse: row.total_rows,
    rowsWithCanonicalIdentity: row.with_canonical,
    uniqueCanonicalIdentities: row.unique_canonical,
    canonicalDuplicateGroupsRemaining: duplicateGroupsRemaining,
    economicConflicts: 0,
    gateRequirementMet: duplicateGroupsRemaining === 0,
  };
}

async function main() {
  await assertGatePassed();
  const db = getDb();
  const rowsBefore = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(walletLedgerEvents)
    .where(eq(walletLedgerEvents.walletAddress, WALLET));
  const beforeCount = rowsBefore[0]?.count ?? 0;
  console.error(`[migration] rows before=${beforeCount}`);

  await applySchemaMigration(db);
  const backfilled = await backfillCanonicalIdentity(db);
  const collapse = await collapseDuplicates(db);
  if (collapse.economicConflicts > 0) {
    console.error(
      JSON.stringify(
        {
          recommendation: "FIX_REQUIRED",
          economicConflicts: collapse.economicConflicts,
        },
        null,
        2
      )
    );
    process.exit(1);
  }
  await createUniquePartialIndex(db);
  const report = await postMigrationReport(db);
  const result = {
    mode: "canonical_identity_migration",
    rowsBeforeCollapse: beforeCount,
    rowsBackfilled: backfilled,
    duplicateRowsDeleted: collapse.deleted,
    ...report,
    recommendation:
      report.gateRequirementMet ? "MIGRATION_COMPLETE" : "FIX_REQUIRED",
  };
  console.log(JSON.stringify(result, null, 2));
  console.error(
    "[migration] Set CANONICAL_IDENTITY_MIGRATED=1 in .env.local to enable canonical_identity writes."
  );
  if (!report.gateRequirementMet) process.exit(1);
}

void main().catch((error) => {
  console.error("[apply-canonical-identity-migration] failed:", error);
  process.exit(1);
});
