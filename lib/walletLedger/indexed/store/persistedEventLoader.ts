import { and, asc, eq, sql } from "drizzle-orm";
import { walletLedgerEvents } from "@/lib/crossmarket/store/schema";
import { getDb } from "@/lib/crossmarket/store/db";
import { assignChainEventDedupeKey, hasCanonicalChainLogCoordinates } from "@/lib/walletLedger/canonicalChainIdentity";
import { auditLog, isAuditProgressEnabled } from "@/lib/walletLedger/indexed/auditProgress";
import { QueryScaleError } from "@/lib/walletLedger/indexed/shadow/infraClassification";
import { retryTransient } from "@/lib/walletLedger/indexed/shadow/transientRetry";
import type { WalletLedgerEvent } from "@/lib/walletLedger/types";

export const PERSISTED_EVENT_PAGE_SIZE = 5_000;

export interface PersistedEventKeysetCursor {
  blockNumber: number;
  id: number;
}

export interface PersistedEventRowSlice {
  id: number;
  walletAddress: string;
  dedupeKey: string;
  txHash: string | null;
  logIndex: string | null;
  blockNumber: number | null;
  blockTimestamp: number | null;
  eventType: string;
  marketConditionId: string | null;
  assetId: string | null;
  shares: number | null;
  cashUsd: number | null;
  price: number | null;
  source: string;
}

export interface PersistedEventLoadStats {
  persistedEventRows: number;
  persistedEventPages: number;
  persistedEventPageSize: number;
  persistedEventLoadMs: number;
  largestPageMs: number;
  loadedBytesApprox: number;
  heapBeforeMb: number;
  heapAfterMb: number;
  uniqueDedupeKeys: number;
}

let lastPersistedEventLoadStats: PersistedEventLoadStats | null = null;

export function getLastPersistedEventLoadStats(): PersistedEventLoadStats | null {
  return lastPersistedEventLoadStats;
}

export function mapPersistedRowToWalletLedgerEvent(
  row: PersistedEventRowSlice
): WalletLedgerEvent {
  const base: WalletLedgerEvent = {
    wallet: row.walletAddress,
    conditionId: row.marketConditionId ?? "",
    asset: row.assetId ?? "",
    timestamp: Number(row.blockTimestamp ?? 0),
    type: row.eventType as WalletLedgerEvent["type"],
    shares: row.shares ?? undefined,
    cashUsd: row.cashUsd ?? undefined,
    price: row.price ?? undefined,
    txHash: row.txHash ?? undefined,
    source: row.source as WalletLedgerEvent["source"],
    blockNumber: row.blockNumber ?? undefined,
    logIndex:
      row.logIndex != null && row.logIndex !== ""
        ? Number.parseInt(row.logIndex, 10)
        : undefined,
    dedupeKey: row.dedupeKey,
  };
  if (hasCanonicalChainLogCoordinates(base)) {
    return assignChainEventDedupeKey(base);
  }
  return base;
}

export function buildKeysetCursorFromRows(
  rows: PersistedEventRowSlice[]
): PersistedEventKeysetCursor | null {
  const last = rows.at(-1);
  if (!last) return null;
  return {
    blockNumber: last.blockNumber ?? 0,
    id: last.id,
  };
}

/** Pure helper for tests — filters sorted rows using the same keyset rule as SQL. */
export function sliceKeysetPage(
  sortedRows: PersistedEventRowSlice[],
  cursor: PersistedEventKeysetCursor | null,
  pageSize: number
): PersistedEventRowSlice[] {
  const filtered =
    cursor == null
      ? sortedRows
      : sortedRows.filter((row) => {
          const block = row.blockNumber ?? 0;
          return (
            block > cursor.blockNumber ||
            (block === cursor.blockNumber && row.id > cursor.id)
          );
        });
  return filtered.slice(0, pageSize);
}

export function approximateRowBytes(row: PersistedEventRowSlice): number {
  return (
    row.dedupeKey.length +
    (row.txHash?.length ?? 0) +
    (row.marketConditionId?.length ?? 0) +
    (row.assetId?.length ?? 0) +
    (row.eventType?.length ?? 0) +
    (row.source?.length ?? 0) +
    (row.walletAddress?.length ?? 0) +
    64
  );
}

async function fetchPersistedEventPage(
  db: ReturnType<typeof getDb>,
  walletAddress: string,
  cursor: PersistedEventKeysetCursor | null,
  pageSize: number
): Promise<PersistedEventRowSlice[]> {
  const cursorFilter =
    cursor == null
      ? sql`true`
      : sql`(${walletLedgerEvents.blockNumber}, ${walletLedgerEvents.id}) > (${cursor.blockNumber}, ${cursor.id})`;

  return db
    .select({
      id: walletLedgerEvents.id,
      walletAddress: walletLedgerEvents.walletAddress,
      dedupeKey: walletLedgerEvents.dedupeKey,
      txHash: walletLedgerEvents.txHash,
      logIndex: walletLedgerEvents.logIndex,
      blockNumber: walletLedgerEvents.blockNumber,
      blockTimestamp: walletLedgerEvents.blockTimestamp,
      eventType: walletLedgerEvents.eventType,
      marketConditionId: walletLedgerEvents.marketConditionId,
      assetId: walletLedgerEvents.assetId,
      shares: walletLedgerEvents.shares,
      cashUsd: walletLedgerEvents.cashUsd,
      price: walletLedgerEvents.price,
      source: walletLedgerEvents.source,
    })
    .from(walletLedgerEvents)
    .where(
      and(
        eq(walletLedgerEvents.walletAddress, walletAddress),
        cursorFilter
      )
    )
    .orderBy(asc(walletLedgerEvents.blockNumber), asc(walletLedgerEvents.id))
    .limit(pageSize);
}

export type PersistedEventPageFetcher = (
  cursor: PersistedEventKeysetCursor | null,
  pageSize: number
) => Promise<PersistedEventRowSlice[]>;

export async function loadPersistedEventsWithFetcher(
  walletAddress: string,
  fetchPage: PersistedEventPageFetcher,
  options: { pageSize?: number } = {}
): Promise<{ events: WalletLedgerEvent[]; stats: PersistedEventLoadStats }> {
  const pageSize = options.pageSize ?? PERSISTED_EVENT_PAGE_SIZE;
  const heapBeforeMb = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
  const loadStarted = Date.now();
  let cursor: PersistedEventKeysetCursor | null = null;
  let pages = 0;
  let largestPageMs = 0;
  let loadedBytesApprox = 0;
  const events: WalletLedgerEvent[] = [];
  const dedupeKeys = new Set<string>();

  while (true) {
    const pageStarted = Date.now();
    const page = await retryTransient(
      () => fetchPage(cursor, pageSize),
      { maxAttempts: 4, label: "loadPersistedEventPage" }
    ).catch((error) => {
      throw new QueryScaleError(
        `persisted event page load failed wallet=${walletAddress} page=${pages + 1}`,
        error
      );
    });
    const pageMs = Date.now() - pageStarted;
    largestPageMs = Math.max(largestPageMs, pageMs);
    pages += 1;

    if (isAuditProgressEnabled()) {
      const last = page.at(-1);
      auditLog(
        `[persisted-events] page=${pages} rows=${page.length} lastBlock=${last?.blockNumber ?? "none"} lastId=${last?.id ?? "none"} elapsedMs=${pageMs}`
      );
    }

    for (const row of page) {
      loadedBytesApprox += approximateRowBytes(row);
      dedupeKeys.add(row.dedupeKey);
      events.push(mapPersistedRowToWalletLedgerEvent(row));
    }

    if (page.length < pageSize) break;
    cursor = buildKeysetCursorFromRows(page);
    if (!cursor) break;
  }

  const stats: PersistedEventLoadStats = {
    persistedEventRows: events.length,
    persistedEventPages: pages,
    persistedEventPageSize: pageSize,
    persistedEventLoadMs: Date.now() - loadStarted,
    largestPageMs,
    loadedBytesApprox,
    heapBeforeMb,
    heapAfterMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    uniqueDedupeKeys: dedupeKeys.size,
  };
  lastPersistedEventLoadStats = stats;

  if (isAuditProgressEnabled()) {
    auditLog(
      `[persisted-events] complete wallet=${walletAddress} rows=${stats.persistedEventRows} pages=${stats.persistedEventPages} loadMs=${stats.persistedEventLoadMs} largestPageMs=${stats.largestPageMs} heapBeforeMb=${stats.heapBeforeMb} heapAfterMb=${stats.heapAfterMb} uniqueDedupeKeys=${stats.uniqueDedupeKeys}`
    );
  }

  return { events, stats };
}

export async function loadPersistedWalletEventsPaginated(
  db: ReturnType<typeof getDb>,
  walletAddress: string,
  options: { pageSize?: number } = {}
): Promise<{ events: WalletLedgerEvent[]; stats: PersistedEventLoadStats }> {
  return loadPersistedEventsWithFetcher(
    walletAddress,
    (cursor, pageSize) => fetchPersistedEventPage(db, walletAddress, cursor, pageSize),
    options
  );
}

export async function countPersistedWalletEvents(
  walletAddress: string
): Promise<number> {
  const db = getDb();
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(walletLedgerEvents)
    .where(eq(walletLedgerEvents.walletAddress, walletAddress));
  return row?.count ?? 0;
}

export function paginateSortedPersistedRows(
  sortedRows: PersistedEventRowSlice[],
  pageSize: number
): PersistedEventRowSlice[] {
  const loaded: PersistedEventRowSlice[] = [];
  let cursor: PersistedEventKeysetCursor | null = null;
  let startIndex = 0;
  while (true) {
    const page = sliceKeysetPageFromIndex(
      sortedRows,
      cursor,
      pageSize,
      startIndex
    );
    loaded.push(...page.rows);
    if (page.rows.length < pageSize) break;
    cursor = buildKeysetCursorFromRows(page.rows);
    if (!cursor) break;
    startIndex = page.nextStartIndex;
  }
  return loaded;
}

function sliceKeysetPageFromIndex(
  sortedRows: PersistedEventRowSlice[],
  cursor: PersistedEventKeysetCursor | null,
  pageSize: number,
  startIndex: number
): { rows: PersistedEventRowSlice[]; nextStartIndex: number } {
  const rows: PersistedEventRowSlice[] = [];
  let i = startIndex;
  for (; i < sortedRows.length && rows.length < pageSize; i += 1) {
    const row = sortedRows[i]!;
    const block = row.blockNumber ?? 0;
    if (
      cursor != null &&
      !(
        block > cursor.blockNumber ||
        (block === cursor.blockNumber && row.id > cursor.id)
      )
    ) {
      continue;
    }
    rows.push(row);
  }
  const lastConsumedIndex =
    rows.length > 0
      ? sortedRows.findIndex((row) => row.id === rows.at(-1)!.id)
      : startIndex;
  return {
    rows,
    nextStartIndex: lastConsumedIndex >= 0 ? lastConsumedIndex + 1 : i,
  };
}
