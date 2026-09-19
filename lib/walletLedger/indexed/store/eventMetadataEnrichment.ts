import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { getDb } from "@/lib/crossmarket/store/db";
import { walletLedgerEvents } from "@/lib/crossmarket/store/schema";
import { withDbCircuit } from "@/lib/walletLedger/indexed/shadow/dbCircuitBreaker";
import { retryTransient } from "@/lib/walletLedger/indexed/shadow/transientRetry";
import { withDbQueryTimeout } from "@/lib/walletLedger/indexed/store/dbQueryTimeout";
import { assertPersistenceNotAborted } from "@/lib/walletLedger/indexed/store/persistenceAbort";
import type { WalletLedgerEvent } from "@/lib/walletLedger/types";

const METADATA_ENRICH_CHUNK_SIZE = 250;

export type MetadataEnrichmentField =
  | "logIndex"
  | "blockTimestamp"
  | "blockNumber";

export interface MetadataEnrichmentConflict {
  dedupeKey: string;
  field: MetadataEnrichmentField;
  existing: string | number | null;
  incoming: string | number | null;
}

export interface PersistedEventMetadataRow {
  dedupeKey: string;
  logIndex: string | null;
  blockNumber: number | null;
  blockTimestamp: number | null;
  txHash?: string | null;
  assetId?: string | null;
  eventType?: string | null;
  shares?: number | null;
  cashUsd?: number | null;
}

export function chainCoordinateLogIndexKey(
  input: Pick<
    WalletLedgerEvent,
    "txHash" | "blockNumber" | "asset" | "type" | "shares" | "cashUsd"
  >
): string | null {
  if (!input.txHash || !input.blockNumber || input.blockNumber <= 0) {
    return null;
  }
  return [
    input.txHash.toLowerCase(),
    input.blockNumber,
    input.asset ?? "",
    input.type,
    input.shares != null ? input.shares.toFixed(6) : "",
    input.cashUsd != null ? input.cashUsd.toFixed(6) : "",
  ].join("|");
}

export function buildChainCoordinateLogIndexLookup(
  events: WalletLedgerEvent[]
): Map<string, number> {
  const map = new Map<string, number>();
  for (const event of events) {
    if (event.logIndex == null || event.logIndex < 0) continue;
    const key = chainCoordinateLogIndexKey(event);
    if (!key) continue;
    if (!map.has(key)) {
      map.set(key, event.logIndex);
    }
  }
  return map;
}

export function resolveIncomingEventForEnrichment(
  existing: PersistedEventMetadataRow,
  byDedupeKey: Map<string, WalletLedgerEvent>,
  chainLogIndexLookup: Map<string, number>
): WalletLedgerEvent | null {
  const direct = byDedupeKey.get(existing.dedupeKey);
  if (direct?.logIndex != null && direct.logIndex >= 0) {
    return direct;
  }
  const coordinateKey =
    existing.txHash && existing.blockNumber
      ? chainCoordinateLogIndexKey({
          txHash: existing.txHash,
          blockNumber: existing.blockNumber,
          asset: existing.assetId ?? "",
          type: (existing.eventType ?? "BUY") as WalletLedgerEvent["type"],
          shares: existing.shares ?? undefined,
          cashUsd: existing.cashUsd ?? undefined,
        })
      : null;
  const logIndex =
    coordinateKey != null ? chainLogIndexLookup.get(coordinateKey) : undefined;
  if (logIndex == null) {
    return direct ?? null;
  }
  return {
    wallet: "",
    conditionId: "",
    asset: existing.assetId ?? "",
    timestamp: existing.blockTimestamp ?? 0,
    type: (existing.eventType ?? "BUY") as WalletLedgerEvent["type"],
    source: "polygon",
    dedupeKey: existing.dedupeKey,
    blockNumber: existing.blockNumber ?? undefined,
    logIndex,
  };
}

export interface MetadataEnrichmentStats {
  candidateEvents: number;
  existingRowsMatched: number;
  logIndexBackfills: number;
  timestampBackfills: number;
  blockNumberBackfills: number;
  metadataConflicts: number;
  rowsUnchanged: number;
  conflictSamples: MetadataEnrichmentConflict[];
  writeMs: number;
}

function normalizeWalletAddress(wallet: string): string {
  return wallet.toLowerCase();
}

function chunkItems<T>(items: T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize));
  }
  return chunks;
}

export function incomingLogIndexString(
  event: WalletLedgerEvent
): string | null {
  return event.logIndex != null && event.logIndex >= 0
    ? String(event.logIndex)
    : null;
}

export function isNullPersistedLogIndex(
  value: string | null | undefined
): boolean {
  return value == null || value === "";
}

export function normalizedBlockNumber(
  value: number | null | undefined
): number | null {
  return value != null && value > 0 ? value : null;
}

export function normalizedBlockTimestamp(
  value: number | null | undefined
): number | null {
  return value != null && value > 0 ? value : null;
}

export function planMetadataEnrichmentForEvent(
  existing: PersistedEventMetadataRow,
  incoming: WalletLedgerEvent
): {
  patch: Partial<{
    logIndex: string;
    blockNumber: number;
    blockTimestamp: number;
  }>;
  conflicts: MetadataEnrichmentConflict[];
} {
  const patch: Partial<{
    logIndex: string;
    blockNumber: number;
    blockTimestamp: number;
  }> = {};
  const conflicts: MetadataEnrichmentConflict[] = [];

  const incomingLogIndex = incomingLogIndexString(incoming);
  if (isNullPersistedLogIndex(existing.logIndex)) {
    if (incomingLogIndex != null) {
      patch.logIndex = incomingLogIndex;
    }
  } else if (
    incomingLogIndex != null &&
    existing.logIndex !== incomingLogIndex
  ) {
    conflicts.push({
      dedupeKey: existing.dedupeKey,
      field: "logIndex",
      existing: existing.logIndex,
      incoming: incomingLogIndex,
    });
  }

  const incomingTimestamp = normalizedBlockTimestamp(incoming.timestamp);
  const existingTimestamp = normalizedBlockTimestamp(existing.blockTimestamp);
  if (existingTimestamp == null) {
    if (incomingTimestamp != null) {
      patch.blockTimestamp = incomingTimestamp;
    }
  } else if (
    incomingTimestamp != null &&
    existingTimestamp !== incomingTimestamp
  ) {
    conflicts.push({
      dedupeKey: existing.dedupeKey,
      field: "blockTimestamp",
      existing: existingTimestamp,
      incoming: incomingTimestamp,
    });
  }

  const incomingBlock = normalizedBlockNumber(incoming.blockNumber);
  const existingBlock = normalizedBlockNumber(existing.blockNumber);
  if (existingBlock == null) {
    if (incomingBlock != null) {
      patch.blockNumber = incomingBlock;
    }
  } else if (incomingBlock != null && existingBlock !== incomingBlock) {
    conflicts.push({
      dedupeKey: existing.dedupeKey,
      field: "blockNumber",
      existing: existingBlock,
      incoming: incomingBlock,
    });
  }

  return { patch, conflicts };
}

const MAX_CONFLICT_SAMPLES = 20;

interface PlannedMetadataPatch {
  dedupeKey: string;
  patch: Partial<{
    logIndex: string;
    blockNumber: number;
    blockTimestamp: number;
  }>;
}

async function applyLogIndexPatchBatch(
  walletAddress: string,
  patches: PlannedMetadataPatch[]
): Promise<number> {
  if (patches.length === 0) return 0;
  const db = getDb();
  const valueTuples = patches.map(
    (patch) => sql`(${patch.dedupeKey}, ${patch.patch.logIndex!})`
  );
  const rows = await withDbCircuit("patchPersistedEventLogIndexBatch", () =>
    withDbQueryTimeout("patchPersistedEventLogIndexBatch", () =>
      retryTransient(
        () =>
          db.execute(sql`
            UPDATE wallet_ledger_events AS w
            SET
              log_index = patch_data.log_index,
              updated_at = NOW()
            FROM (
              VALUES ${sql.join(valueTuples, sql`, `)}
            ) AS patch_data(dedupe_key, log_index)
            WHERE w.wallet_address = ${walletAddress}
              AND w.dedupe_key = patch_data.dedupe_key
              AND (w.log_index IS NULL OR w.log_index = '')
            RETURNING w.dedupe_key
          `),
        { maxAttempts: 4, label: "patchPersistedEventLogIndexBatch" }
      )
    )
  );
  return Array.isArray(rows) ? rows.length : rows.rows?.length ?? 0;
}

async function applyTimestampPatchBatch(
  walletAddress: string,
  patches: PlannedMetadataPatch[]
): Promise<number> {
  if (patches.length === 0) return 0;
  const db = getDb();
  const valueTuples = patches.map(
    (patch) =>
      sql`(${patch.dedupeKey}::text, ${patch.patch.blockTimestamp!}::bigint)`
  );
  const rows = await withDbCircuit("patchPersistedEventTimestampBatch", () =>
    withDbQueryTimeout("patchPersistedEventTimestampBatch", () =>
      retryTransient(
        () =>
          db.execute(sql`
            UPDATE wallet_ledger_events AS w
            SET
              block_timestamp = patch_data.block_timestamp,
              updated_at = NOW()
            FROM (
              VALUES ${sql.join(valueTuples, sql`, `)}
            ) AS patch_data(dedupe_key, block_timestamp)
            WHERE w.wallet_address = ${walletAddress}
              AND w.dedupe_key = patch_data.dedupe_key
              AND w.block_timestamp IS NULL
            RETURNING w.dedupe_key
          `),
        { maxAttempts: 4, label: "patchPersistedEventTimestampBatch" }
      )
    )
  );
  return Array.isArray(rows) ? rows.length : rows.rows?.length ?? 0;
}

async function applyBlockNumberPatchBatch(
  walletAddress: string,
  patches: PlannedMetadataPatch[]
): Promise<number> {
  if (patches.length === 0) return 0;
  const db = getDb();
  const valueTuples = patches.map(
    (patch) =>
      sql`(${patch.dedupeKey}::text, ${patch.patch.blockNumber!}::bigint)`
  );
  const rows = await withDbCircuit("patchPersistedEventBlockNumberBatch", () =>
    withDbQueryTimeout("patchPersistedEventBlockNumberBatch", () =>
      retryTransient(
        () =>
          db.execute(sql`
            UPDATE wallet_ledger_events AS w
            SET
              block_number = patch_data.block_number,
              updated_at = NOW()
            FROM (
              VALUES ${sql.join(valueTuples, sql`, `)}
            ) AS patch_data(dedupe_key, block_number)
            WHERE w.wallet_address = ${walletAddress}
              AND w.dedupe_key = patch_data.dedupe_key
              AND w.block_number IS NULL
            RETURNING w.dedupe_key
          `),
        { maxAttempts: 4, label: "patchPersistedEventBlockNumberBatch" }
      )
    )
  );
  return Array.isArray(rows) ? rows.length : rows.rows?.length ?? 0;
}

async function applyMixedMetadataPatch(
  walletAddress: string,
  patch: PlannedMetadataPatch
): Promise<boolean> {
  const whereParts = [
    eq(walletLedgerEvents.walletAddress, walletAddress),
    eq(walletLedgerEvents.dedupeKey, patch.dedupeKey),
  ];
  if (patch.patch.logIndex != null) {
    whereParts.push(
      or(
        isNull(walletLedgerEvents.logIndex),
        eq(walletLedgerEvents.logIndex, "")
      )!
    );
  }
  if (patch.patch.blockTimestamp != null) {
    whereParts.push(isNull(walletLedgerEvents.blockTimestamp));
  }
  if (patch.patch.blockNumber != null) {
    whereParts.push(isNull(walletLedgerEvents.blockNumber));
  }
  const db = getDb();
  const updated = await withDbCircuit("patchPersistedEventMetadata", () =>
    withDbQueryTimeout("patchPersistedEventMetadata", () =>
      retryTransient(
        () =>
          db
            .update(walletLedgerEvents)
            .set({
              ...patch.patch,
              updatedAt: new Date(),
            })
            .where(and(...whereParts))
            .returning({ dedupeKey: walletLedgerEvents.dedupeKey }),
        { maxAttempts: 4, label: "patchPersistedEventMetadata" }
      )
    )
  );
  return updated.length > 0;
}

export async function enrichPersistedLedgerEventMetadata(
  wallet: string,
  events: WalletLedgerEvent[],
  options: { abortSignal?: AbortSignal } = {}
): Promise<MetadataEnrichmentStats> {
  const walletAddress = normalizeWalletAddress(wallet);
  const byKey = new Map<string, WalletLedgerEvent>();
  for (const event of events) {
    if (!event.dedupeKey) continue;
    if (!byKey.has(event.dedupeKey)) {
      byKey.set(event.dedupeKey, event);
    }
  }
  const candidates = [...byKey.values()];
  const chainLogIndexLookup = buildChainCoordinateLogIndexLookup(candidates);
  const stats: MetadataEnrichmentStats = {
    candidateEvents: candidates.length,
    existingRowsMatched: 0,
    logIndexBackfills: 0,
    timestampBackfills: 0,
    blockNumberBackfills: 0,
    metadataConflicts: 0,
    rowsUnchanged: 0,
    conflictSamples: [],
    writeMs: 0,
  };
  if (candidates.length === 0) return stats;

  const db = getDb();
  const writeStarted = Date.now();
  const chunks = chunkItems(candidates, METADATA_ENRICH_CHUNK_SIZE);

  for (const chunk of chunks) {
    assertPersistenceNotAborted(options.abortSignal, "event-metadata-enrich");
    const dedupeKeys = chunk.map((event) => event.dedupeKey);
    const existingRows = await withDbCircuit("loadPersistedEventMetadata", () =>
      withDbQueryTimeout("loadPersistedEventMetadata", () =>
        db
          .select({
            dedupeKey: walletLedgerEvents.dedupeKey,
            logIndex: walletLedgerEvents.logIndex,
            blockNumber: walletLedgerEvents.blockNumber,
            blockTimestamp: walletLedgerEvents.blockTimestamp,
            txHash: walletLedgerEvents.txHash,
            assetId: walletLedgerEvents.assetId,
            eventType: walletLedgerEvents.eventType,
            shares: walletLedgerEvents.shares,
            cashUsd: walletLedgerEvents.cashUsd,
          })
          .from(walletLedgerEvents)
          .where(
            and(
              eq(walletLedgerEvents.walletAddress, walletAddress),
              inArray(walletLedgerEvents.dedupeKey, dedupeKeys)
            )
          )
      )
    );

    const plannedPatches: PlannedMetadataPatch[] = [];
    for (const existing of existingRows) {
      stats.existingRowsMatched += 1;
      const incoming = resolveIncomingEventForEnrichment(
        existing,
        byKey,
        chainLogIndexLookup
      );
      if (!incoming) continue;
      const { patch, conflicts } = planMetadataEnrichmentForEvent(
        existing,
        incoming
      );
      stats.metadataConflicts += conflicts.length;
      for (const conflict of conflicts) {
        if (stats.conflictSamples.length >= MAX_CONFLICT_SAMPLES) continue;
        stats.conflictSamples.push(conflict);
      }
      if (Object.keys(patch).length === 0) {
        stats.rowsUnchanged += 1;
        continue;
      }
      plannedPatches.push({ dedupeKey: existing.dedupeKey, patch });
    }

    const logIndexOnly = plannedPatches.filter(
      (row) =>
        row.patch.logIndex != null &&
        row.patch.blockTimestamp == null &&
        row.patch.blockNumber == null
    );
    const timestampOnly = plannedPatches.filter(
      (row) =>
        row.patch.blockTimestamp != null &&
        row.patch.logIndex == null &&
        row.patch.blockNumber == null
    );
    const blockNumberOnly = plannedPatches.filter(
      (row) =>
        row.patch.blockNumber != null &&
        row.patch.logIndex == null &&
        row.patch.blockTimestamp == null
    );
    const mixed = plannedPatches.filter((row) => {
      const fields = [
        row.patch.logIndex != null,
        row.patch.blockTimestamp != null,
        row.patch.blockNumber != null,
      ].filter(Boolean).length;
      return fields > 1;
    });

    stats.logIndexBackfills += await applyLogIndexPatchBatch(
      walletAddress,
      logIndexOnly
    );
    stats.timestampBackfills += await applyTimestampPatchBatch(
      walletAddress,
      timestampOnly
    );
    stats.blockNumberBackfills += await applyBlockNumberPatchBatch(
      walletAddress,
      blockNumberOnly
    );
    for (const patch of mixed) {
      const applied = await applyMixedMetadataPatch(walletAddress, patch);
      if (!applied) {
        stats.metadataConflicts += 1;
        continue;
      }
      if (patch.patch.logIndex != null) stats.logIndexBackfills += 1;
      if (patch.patch.blockTimestamp != null) stats.timestampBackfills += 1;
      if (patch.patch.blockNumber != null) stats.blockNumberBackfills += 1;
    }
  }

  stats.writeMs = Date.now() - writeStarted;
  return stats;
}

export async function countPersistedEventMetadataCoverage(wallet: string) {
  const db = getDb();
  const walletAddress = normalizeWalletAddress(wallet);
  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      withLogIndex: sql<number>`count(*) filter (where ${walletLedgerEvents.logIndex} is not null and ${walletLedgerEvents.logIndex} <> '')::int`,
      withBlock: sql<number>`count(*) filter (where ${walletLedgerEvents.blockNumber} is not null and ${walletLedgerEvents.blockNumber} > 0)::int`,
      withTimestamp: sql<number>`count(*) filter (where ${walletLedgerEvents.blockTimestamp} is not null and ${walletLedgerEvents.blockTimestamp} > 0)::int`,
      polygonSource: sql<number>`count(*) filter (where ${walletLedgerEvents.source} = 'polygon')::int`,
      apiSource: sql<number>`count(*) filter (where ${walletLedgerEvents.source} <> 'polygon')::int`,
    })
    .from(walletLedgerEvents)
    .where(eq(walletLedgerEvents.walletAddress, walletAddress));
  return {
    total: row?.total ?? 0,
    withLogIndex: row?.withLogIndex ?? 0,
    withBlock: row?.withBlock ?? 0,
    withTimestamp: row?.withTimestamp ?? 0,
    polygonSource: row?.polygonSource ?? 0,
    apiSource: row?.apiSource ?? 0,
    missingLogIndex: (row?.total ?? 0) - (row?.withLogIndex ?? 0),
  };
}
