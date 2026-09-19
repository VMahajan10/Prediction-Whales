import { and, eq, inArray, sql } from "drizzle-orm";
import { buildCanonicalChainLogIdentity } from "@/lib/walletLedger/canonicalChainIdentity";
import { getDb } from "@/lib/crossmarket/store/db";
import { walletLedgerEvents } from "@/lib/crossmarket/store/schema";
import { normalizeWalletAddress } from "@/lib/walletLedger/indexed/store/persistWalletHistory";

const BATCH_SIZE = 5_000;

export interface CanonicalRowSlice {
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

export interface CanonicalDuplicateGroupReport {
  canonicalIdentity: string;
  rowIds: number[];
  dedupeKeys: string[];
  economicKeys: string[];
  metadataOnly: boolean;
  economicConflict: boolean;
}

export interface CanonicalDuplicateAuditReport {
  wallet: string;
  totalDbRows: number;
  rowsWithCanonicalIdentity: number;
  rowsWithoutCanonicalIdentity: number;
  uniqueCanonicalPhysicalIdentities: number;
  duplicateGroups: number;
  duplicateExcessRows: number;
  metadataOnlyDuplicateGroups: number;
  economicConflictGroups: number;
  legacyOnlyRows: number;
  canonicalInsertedCopyEstimate: number;
  samePhysicalDuplicatePairs: number;
  groups: CanonicalDuplicateGroupReport[];
}

function deriveCanonical(row: CanonicalRowSlice): string | null {
  if (!row.tx_hash || row.log_index == null || row.log_index === "") {
    return null;
  }
  const logIndex = Number.parseInt(row.log_index, 10);
  if (!Number.isFinite(logIndex) || logIndex < 0) return null;
  return buildCanonicalChainLogIdentity({ txHash: row.tx_hash, logIndex });
}

function economicKey(row: CanonicalRowSlice): string {
  return [
    row.event_type,
    row.asset_id ?? "",
    row.shares?.toFixed(6) ?? "",
    row.cash_usd?.toFixed(6) ?? "",
    row.price?.toFixed(6) ?? "",
  ].join("|");
}

function pickSurvivor(group: CanonicalRowSlice[]): CanonicalRowSlice {
  const withCanonical = group.filter((row) => row.canonical_identity);
  const pool = withCanonical.length > 0 ? withCanonical : group;
  return [...pool].sort((a, b) => a.id - b.id)[0]!;
}

function mergeMetadata(
  survivor: CanonicalRowSlice,
  row: CanonicalRowSlice
): Partial<CanonicalRowSlice> {
  const patch: Partial<CanonicalRowSlice> = {};
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
  if (!survivor.canonical_identity && row.canonical_identity) {
    patch.canonical_identity = row.canonical_identity;
  }
  return patch;
}

async function loadWalletRows(
  wallet: string
): Promise<CanonicalRowSlice[]> {
  const db = getDb();
  const walletAddress = normalizeWalletAddress(wallet);
  const allRows: CanonicalRowSlice[] = [];
  let cursorId = 0;
  while (true) {
    const page = await db.execute(sql`
      SELECT
        id, dedupe_key, canonical_identity, tx_hash, log_index,
        block_number, block_timestamp, event_type, asset_id, shares, cash_usd, price
      FROM wallet_ledger_events
      WHERE wallet_address = ${walletAddress}
        AND id > ${cursorId}
      ORDER BY id ASC
      LIMIT ${BATCH_SIZE}
    `);
    const batch = page.rows as unknown as CanonicalRowSlice[];
    if (batch.length === 0) break;
    allRows.push(...batch);
    cursorId = batch[batch.length - 1]!.id;
    if (batch.length < BATCH_SIZE) break;
  }
  return allRows;
}

export async function auditCanonicalDuplicates(
  wallet: string
): Promise<CanonicalDuplicateAuditReport> {
  const rows = await loadWalletRows(wallet);
  const byPhysical = new Map<string, CanonicalRowSlice[]>();
  let rowsWithCanonicalIdentity = 0;
  let legacyOnlyRows = 0;

  for (const row of rows) {
    const physical = row.canonical_identity ?? deriveCanonical(row);
    if (row.canonical_identity) rowsWithCanonicalIdentity += 1;
    if (!physical) {
      legacyOnlyRows += 1;
      continue;
    }
    const list = byPhysical.get(physical) ?? [];
    list.push(row);
    byPhysical.set(physical, list);
  }

  for (const row of rows) {
    if (row.canonical_identity) continue;
    const physical = deriveCanonical(row);
    if (!physical) continue;
    const list = byPhysical.get(physical) ?? [];
    if (!list.some((entry) => entry.id === row.id)) {
      list.push(row);
      byPhysical.set(physical, list);
    }
  }

  const groups: CanonicalDuplicateGroupReport[] = [];
  let duplicateExcessRows = 0;
  let metadataOnlyDuplicateGroups = 0;
  let economicConflictGroups = 0;
  let samePhysicalDuplicatePairs = 0;
  let canonicalInsertedCopyEstimate = 0;

  for (const [canonicalIdentity, group] of byPhysical) {
    if (group.length <= 1) continue;
    const economicKeys = [...new Set(group.map(economicKey))];
    const dedupeKeys = [...new Set(group.map((row) => row.dedupe_key))];
    const economicConflict = economicKeys.length > 1;
    const metadataOnly = !economicConflict;
    duplicateExcessRows += group.length - 1;
    samePhysicalDuplicatePairs += 1;
    if (economicConflict) economicConflictGroups += 1;
    if (metadataOnly) metadataOnlyDuplicateGroups += 1;
    const hasLegacy = group.some((row) => !row.canonical_identity);
    const hasCanonical = group.some((row) =>
      row.dedupe_key.startsWith("chain|")
    );
    if (hasLegacy && hasCanonical) canonicalInsertedCopyEstimate += 1;
    groups.push({
      canonicalIdentity,
      rowIds: group.map((row) => row.id),
      dedupeKeys,
      economicKeys,
      metadataOnly,
      economicConflict,
    });
  }

  return {
    wallet: normalizeWalletAddress(wallet),
    totalDbRows: rows.length,
    rowsWithCanonicalIdentity,
    rowsWithoutCanonicalIdentity: rows.length - rowsWithCanonicalIdentity,
    uniqueCanonicalPhysicalIdentities: byPhysical.size,
    duplicateGroups: groups.length,
    duplicateExcessRows,
    metadataOnlyDuplicateGroups,
    economicConflictGroups,
    legacyOnlyRows,
    canonicalInsertedCopyEstimate,
    samePhysicalDuplicatePairs,
    groups,
  };
}

export async function backfillCanonicalIdentityForWallet(
  wallet: string
): Promise<number> {
  const db = getDb();
  const walletAddress = normalizeWalletAddress(wallet);
  const result = await db.execute(sql`
    UPDATE wallet_ledger_events
    SET canonical_identity = 'chain|137|' || lower(tx_hash) || '|' || log_index,
        updated_at = NOW()
    WHERE wallet_address = ${walletAddress}
      AND canonical_identity IS NULL
      AND tx_hash IS NOT NULL
      AND log_index IS NOT NULL
      AND log_index <> ''
      AND log_index ~ '^[0-9]+$'
  `);
  return Number((result as { rowCount?: number }).rowCount ?? 0);
}

async function collapseLegacyCanonicalPairs(
  wallet: string
): Promise<{ deleted: number; economicConflicts: number }> {
  const db = getDb();
  const walletAddress = normalizeWalletAddress(wallet);
  const rows = await loadWalletRows(wallet);
  const canonicalByPhysical = new Map<string, CanonicalRowSlice>();
  for (const row of rows) {
    const physical = row.canonical_identity ?? deriveCanonical(row);
    if (!physical) continue;
    if (!canonicalByPhysical.has(physical)) {
      canonicalByPhysical.set(physical, row);
    }
  }

  let deleted = 0;
  let economicConflicts = 0;
  const deleteIds: number[] = [];

  for (const row of rows) {
    if (row.canonical_identity) continue;
    const physical = deriveCanonical(row);
    if (!physical) continue;
    const canonical = canonicalByPhysical.get(physical);
    if (!canonical || canonical.id === row.id) continue;
    if (economicKey(row) !== economicKey(canonical)) {
      economicConflicts += 1;
      continue;
    }
    deleteIds.push(row.id);
  }

  if (deleteIds.length > 0) {
    for (let i = 0; i < deleteIds.length; i += 500) {
      const chunk = deleteIds.slice(i, i + 500);
      await db
        .delete(walletLedgerEvents)
        .where(inArray(walletLedgerEvents.id, chunk));
      deleted += chunk.length;
    }
  }

  return { deleted, economicConflicts };
}

export async function collapseCanonicalDuplicatesForWallet(
  wallet: string
): Promise<{
  deleted: number;
  economicConflicts: number;
  survivorsUpdated: number;
  legacyPairDeleted: number;
}> {
  const db = getDb();
  const walletAddress = normalizeWalletAddress(wallet);
  const rows = await loadWalletRows(wallet);
  const groups = new Map<string, CanonicalRowSlice[]>();
  for (const row of rows) {
    const key = row.canonical_identity ?? deriveCanonical(row);
    if (!key) continue;
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }

  let deleted = 0;
  let economicConflicts = 0;
  let survivorsUpdated = 0;

  for (const [, group] of groups) {
    if (group.length <= 1) continue;
    const economicKeys = [...new Set(group.map(economicKey))];
    if (economicKeys.length > 1) {
      economicConflicts += 1;
      continue;
    }
    const survivor = pickSurvivor(group);
    let patch: CanonicalRowSlice = { ...survivor };
    for (const row of group) {
      patch = { ...patch, ...mergeMetadata(patch, row) };
    }
    const canonical =
      patch.canonical_identity ??
      deriveCanonical(patch) ??
      survivor.canonical_identity;
    await db
      .update(walletLedgerEvents)
      .set({
        canonicalIdentity: canonical,
        blockNumber: patch.block_number,
        blockTimestamp: patch.block_timestamp,
        logIndex: patch.log_index,
        txHash: patch.tx_hash,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(walletLedgerEvents.id, survivor.id),
          eq(walletLedgerEvents.walletAddress, walletAddress)
        )
      );
    survivorsUpdated += 1;
    const duplicateIds = group
      .filter((row) => row.id !== survivor.id)
      .map((row) => row.id);
    if (duplicateIds.length > 0) {
      await db
        .delete(walletLedgerEvents)
        .where(inArray(walletLedgerEvents.id, duplicateIds));
      deleted += duplicateIds.length;
    }
  }

  const legacyPairs = await collapseLegacyCanonicalPairs(wallet);
  return {
    deleted: deleted + legacyPairs.deleted,
    economicConflicts: economicConflicts + legacyPairs.economicConflicts,
    survivorsUpdated,
    legacyPairDeleted: legacyPairs.deleted,
  };
}

export async function postCollapseGateReport(wallet: string) {
  const db = getDb();
  const walletAddress = normalizeWalletAddress(wallet);
  const counts = await db.execute(sql`
    SELECT
      count(*)::int AS total_rows,
      count(canonical_identity)::int AS with_canonical,
      count(DISTINCT canonical_identity)::int AS unique_canonical
    FROM wallet_ledger_events
    WHERE wallet_address = ${walletAddress}
  `);
  const dupGroups = await db.execute(sql`
    SELECT canonical_identity, count(*)::int AS c
    FROM wallet_ledger_events
    WHERE wallet_address = ${walletAddress}
      AND canonical_identity IS NOT NULL
    GROUP BY canonical_identity
    HAVING count(*) > 1
  `);
  const row = counts.rows[0] as {
    total_rows: number;
    with_canonical: number;
    unique_canonical: number;
  };
  return {
    rowsAfter: row.total_rows,
    rowsWithCanonicalIdentity: row.with_canonical,
    uniqueCanonicalIdentities: row.unique_canonical,
    duplicateCanonicalGroupsRemaining: (dupGroups.rows as unknown[]).length,
  };
}
