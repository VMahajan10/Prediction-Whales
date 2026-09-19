#!/usr/bin/env tsx
/**
 * Read-only audit: canonical_identity collision groups in wallet_ledger_events.
 * Does not mutate data. Run before migration backfill/collapse.
 */
import "../tests/preload-env";
import { sql } from "drizzle-orm";
import { buildCanonicalChainLogIdentity } from "@/lib/walletLedger/canonicalChainIdentity";
import { getDb } from "@/lib/crossmarket/store/db";

const WALLET = (
  process.env.ONLY_WALLET ?? "0x4f29e103339919c4baaea2a60195cf1c8bb27a7e"
).toLowerCase();

interface RowSlice {
  id: number;
  dedupe_key: string;
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

function deriveCanonicalIdentity(row: RowSlice): string | null {
  if (!row.tx_hash || row.log_index == null || row.log_index === "") {
    return null;
  }
  const logIndex = Number.parseInt(row.log_index, 10);
  if (!Number.isFinite(logIndex) || logIndex < 0) return null;
  return buildCanonicalChainLogIdentity({
    txHash: row.tx_hash,
    logIndex,
  });
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

const PAGE_SIZE = 5_000;

async function loadWalletRowsPaginated(
  db: ReturnType<typeof getDb>
): Promise<RowSlice[]> {
  const allRows: RowSlice[] = [];
  let cursorBlock: number | null = null;
  let cursorId: number | null = null;

  while (true) {
    const page =
      cursorBlock == null || cursorId == null
        ? await db.execute<RowSlice>(sql`
            SELECT
              id,
              dedupe_key,
              tx_hash,
              log_index,
              block_number,
              block_timestamp,
              event_type,
              asset_id,
              shares,
              cash_usd,
              price
            FROM wallet_ledger_events
            WHERE wallet_address = ${WALLET}
            ORDER BY block_number ASC NULLS LAST, id ASC
            LIMIT ${PAGE_SIZE}
          `)
        : await db.execute<RowSlice>(sql`
            SELECT
              id,
              dedupe_key,
              tx_hash,
              log_index,
              block_number,
              block_timestamp,
              event_type,
              asset_id,
              shares,
              cash_usd,
              price
            FROM wallet_ledger_events
            WHERE wallet_address = ${WALLET}
              AND (block_number, id) > (${cursorBlock}, ${cursorId})
            ORDER BY block_number ASC NULLS LAST, id ASC
            LIMIT ${PAGE_SIZE}
          `);
    const batch = page.rows as RowSlice[];
    if (batch.length === 0) break;
    allRows.push(...batch);
    const last = batch[batch.length - 1]!;
    cursorBlock = last.block_number ?? 0;
    cursorId = last.id;
    console.error(
      `[audit-canonical-identity-db-collisions] page rows=${batch.length} total=${allRows.length}`
    );
    if (batch.length < PAGE_SIZE) break;
  }
  return allRows;
}

async function main() {
  const db = getDb();
  const allRows = await loadWalletRowsPaginated(db);
  const groups = new Map<string, RowSlice[]>();
  let eligible = 0;

  for (const row of allRows) {
    const canonical = deriveCanonicalIdentity(row);
    if (!canonical) continue;
    eligible += 1;
    const list = groups.get(canonical) ?? [];
    list.push(row);
    groups.set(canonical, list);
  }

  let duplicateGroups = 0;
  let duplicateRows = 0;
  let economicConflicts = 0;
  let metadataOnlyGroups = 0;
  const conflictSamples: Array<{
    canonicalIdentity: string;
    rowIds: number[];
    economicKeys: string[];
    dedupeKeys: string[];
  }> = [];

  for (const [canonicalIdentity, group] of groups.entries()) {
    if (group.length <= 1) continue;
    duplicateGroups += 1;
    duplicateRows += group.length - 1;
    const economicKeys = [...new Set(group.map(economicKey))];
    if (economicKeys.length > 1) {
      economicConflicts += 1;
      if (conflictSamples.length < 10) {
        conflictSamples.push({
          canonicalIdentity,
          rowIds: group.map((row) => row.id),
          economicKeys,
          dedupeKeys: group.map((row) => row.dedupe_key),
        });
      }
    } else {
      metadataOnlyGroups += 1;
    }
  }

  const result = {
    mode: "canonical_identity_db_collision_audit",
    wallet: WALLET,
    totalRows: allRows.length,
    rowsEligibleForCanonicalIdentity: eligible,
    uniqueCanonicalIdentities: groups.size,
    duplicateGroups,
    duplicateRowsToCollapse: duplicateRows,
    metadataOnlyDuplicateGroups: metadataOnlyGroups,
    economicConflictGroups: economicConflicts,
    referencedDuplicateRows: 0,
    referencedDuplicateNote:
      "No foreign keys reference wallet_ledger_events.id in current schema.",
    conflictSamples,
    recommendation:
      economicConflicts > 0
        ? "FIX_REQUIRED"
        : duplicateGroups > 0
          ? "SAFE_TO_PROCEED_WITH_COLLAPSE"
          : "NO_COLLAPSE_NEEDED",
  };

  console.log(JSON.stringify(result, null, 2));
  if (economicConflicts > 0) {
    process.exit(1);
  }
}

void main().catch((error) => {
  console.error("[audit-canonical-identity-db-collisions] failed:", error);
  process.exit(1);
});
