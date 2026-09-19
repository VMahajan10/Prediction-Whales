import { and, asc, eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/crossmarket/store/db";
import { walletLedgerEvents } from "@/lib/crossmarket/store/schema";
import {
  assignChainEventDedupeKey,
  authoritativeEventMergeKey,
  buildCanonicalChainLogIdentity,
  hasCanonicalChainLogCoordinates,
} from "@/lib/walletLedger/canonicalChainIdentity";
import {
  type PersistedEventKeysetCursor,
  buildKeysetCursorFromRows,
} from "@/lib/walletLedger/indexed/store/persistedEventLoader";
import { normalizeWalletAddress } from "@/lib/walletLedger/indexed/store/persistWalletHistory";
import type { WalletLedgerEvent } from "@/lib/walletLedger/types";

const INDEX_PAGE_SIZE = 10_000;

export interface PersistedLedgerRowRef {
  id: number;
  dedupeKey: string;
  canonicalIdentity: string | null;
  txHash: string | null;
  logIndex: number | null;
  blockNumber: number | null;
  eventType: string;
  assetId: string | null;
  shares: number | null;
  cashUsd: number | null;
  source: string;
  walletAddress: string;
}

export interface PersistedAuthoritativeIndex {
  mergeKeys: Set<string>;
  byDedupeKey: Map<string, PersistedLedgerRowRef>;
  byCanonicalIdentity: Map<string, PersistedLedgerRowRef>;
  byPhysicalLog: Map<string, PersistedLedgerRowRef>;
}

export function physicalLogKey(txHash: string, logIndex: number): string {
  return `${txHash.toLowerCase()}|${logIndex}`;
}

function parseLogIndex(value: string | null): number | null {
  if (value == null || value === "") return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function rowToRef(row: {
  id: number;
  dedupeKey: string;
  canonicalIdentity: string | null;
  txHash: string | null;
  logIndex: string | null;
  blockNumber: number | null;
  eventType: string;
  assetId: string | null;
  shares: number | null;
  cashUsd: number | null;
  source: string | null;
  walletAddress: string;
}): PersistedLedgerRowRef {
  return {
    id: row.id,
    dedupeKey: row.dedupeKey,
    canonicalIdentity: row.canonicalIdentity,
    txHash: row.txHash,
    logIndex: parseLogIndex(row.logIndex),
    blockNumber: row.blockNumber,
    eventType: row.eventType,
    assetId: row.assetId,
    shares: row.shares,
    cashUsd: row.cashUsd,
    source: row.source ?? "polygon",
    walletAddress: row.walletAddress,
  };
}

export function mergeKeysForPersistedRow(row: PersistedLedgerRowRef): string[] {
  const keys: string[] = [];
  if (row.canonicalIdentity?.trim()) {
    keys.push(row.canonicalIdentity);
  }
  const event = assignChainEventDedupeKey({
    wallet: row.walletAddress,
    conditionId: "",
    asset: row.assetId ?? "",
    timestamp: 0,
    type: row.eventType as WalletLedgerEvent["type"],
    shares: row.shares ?? undefined,
    cashUsd: row.cashUsd ?? undefined,
    txHash: row.txHash ?? undefined,
    source: (row.source ?? "polygon") as WalletLedgerEvent["source"],
    blockNumber: row.blockNumber ?? undefined,
    logIndex: row.logIndex ?? undefined,
    dedupeKey: row.dedupeKey,
  });
  keys.push(authoritativeEventMergeKey(event));
  return keys;
}

export async function loadPersistedAuthoritativeIndex(
  wallet: string
): Promise<PersistedAuthoritativeIndex> {
  const db = getDb();
  const walletAddress = normalizeWalletAddress(wallet);
  const mergeKeys = new Set<string>();
  const byDedupeKey = new Map<string, PersistedLedgerRowRef>();
  const byCanonicalIdentity = new Map<string, PersistedLedgerRowRef>();
  const byPhysicalLog = new Map<string, PersistedLedgerRowRef>();
  let cursor: PersistedEventKeysetCursor | null = null;

  while (true) {
    const cursorFilter =
      cursor == null
        ? sql`true`
        : sql`(${walletLedgerEvents.blockNumber}, ${walletLedgerEvents.id}) > (${cursor.blockNumber}, ${cursor.id})`;

    const page = await db
      .select({
        id: walletLedgerEvents.id,
        dedupeKey: walletLedgerEvents.dedupeKey,
        canonicalIdentity: walletLedgerEvents.canonicalIdentity,
        txHash: walletLedgerEvents.txHash,
        logIndex: walletLedgerEvents.logIndex,
        blockNumber: walletLedgerEvents.blockNumber,
        walletAddress: walletLedgerEvents.walletAddress,
        eventType: walletLedgerEvents.eventType,
        marketConditionId: walletLedgerEvents.marketConditionId,
        assetId: walletLedgerEvents.assetId,
        shares: walletLedgerEvents.shares,
        cashUsd: walletLedgerEvents.cashUsd,
        source: walletLedgerEvents.source,
      })
      .from(walletLedgerEvents)
      .where(
        and(eq(walletLedgerEvents.walletAddress, walletAddress), cursorFilter)
      )
      .orderBy(asc(walletLedgerEvents.blockNumber), asc(walletLedgerEvents.id))
      .limit(INDEX_PAGE_SIZE);

    if (page.length === 0) break;
    for (const row of page) {
      const ref = rowToRef(row);
      byDedupeKey.set(ref.dedupeKey, ref);
      if (ref.canonicalIdentity) {
        byCanonicalIdentity.set(ref.canonicalIdentity, ref);
      }
      if (ref.txHash && ref.logIndex != null) {
        byPhysicalLog.set(physicalLogKey(ref.txHash, ref.logIndex), ref);
      }
      for (const key of mergeKeysForPersistedRow(ref)) {
        mergeKeys.add(key);
      }
    }
    cursor = buildKeysetCursorFromRows(
      page.map((row) => ({
        id: row.id,
        blockNumber: row.blockNumber,
        walletAddress,
        dedupeKey: row.dedupeKey,
        txHash: row.txHash,
        logIndex: row.logIndex,
        blockTimestamp: null,
        eventType: row.eventType,
        marketConditionId: row.marketConditionId,
        assetId: row.assetId,
        shares: row.shares,
        cashUsd: row.cashUsd,
        price: null,
        source: row.source ?? "polygon",
      }))
    );
    if (page.length < INDEX_PAGE_SIZE) break;
  }

  return { mergeKeys, byDedupeKey, byCanonicalIdentity, byPhysicalLog };
}

export async function loadPersistedAuthoritativeDedupeKeysFromIndex(
  wallet: string
): Promise<Set<string>> {
  const index = await loadPersistedAuthoritativeIndex(wallet);
  return index.mergeKeys;
}

export function isSamePhysicalChainLog(
  event: WalletLedgerEvent,
  row: PersistedLedgerRowRef
): boolean {
  if (!hasCanonicalChainLogCoordinates(event)) return false;
  if (!row.txHash || row.logIndex == null) return false;
  return (
    event.txHash!.toLowerCase() === row.txHash.toLowerCase() &&
    event.logIndex === row.logIndex
  );
}

export class LegacyDedupeKeyCollisionError extends Error {
  readonly code = "LEGACY_DEDUPE_KEY_COLLISION";
  readonly dedupeKey: string;
  readonly incomingCanonicalIdentity: string;
  readonly existingRowId: number;
  readonly existingPhysicalLog: string | null;
  readonly incomingPhysicalLog: string;

  constructor(input: {
    dedupeKey: string;
    incomingCanonicalIdentity: string;
    existingRowId: number;
    existingPhysicalLog: string | null;
    incomingPhysicalLog: string;
  }) {
    super(
      `legacy dedupe_key collision on ${input.dedupeKey}: existing row ${input.existingRowId} (${input.existingPhysicalLog ?? "no coordinates"}) blocks incoming ${input.incomingPhysicalLog}`
    );
    this.name = "LegacyDedupeKeyCollisionError";
    this.dedupeKey = input.dedupeKey;
    this.incomingCanonicalIdentity = input.incomingCanonicalIdentity;
    this.existingRowId = input.existingRowId;
    this.existingPhysicalLog = input.existingPhysicalLog;
    this.incomingPhysicalLog = input.incomingPhysicalLog;
  }
}

export interface CanonicalBackfillResult {
  backfilled: number;
  skippedAlreadyPresent: number;
}

export async function backfillCanonicalIdentityOnLegacyRow(
  wallet: string,
  event: WalletLedgerEvent,
  existingRow: PersistedLedgerRowRef
): Promise<boolean> {
  if (!hasCanonicalChainLogCoordinates(event)) return false;
  const canonicalIdentity = buildCanonicalChainLogIdentity({
    txHash: event.txHash!,
    logIndex: event.logIndex!,
  });
  const db = getDb();
  const walletAddress = normalizeWalletAddress(wallet);
  await db
    .update(walletLedgerEvents)
    .set({
      canonicalIdentity,
      txHash: event.txHash ?? existingRow.txHash,
      logIndex: String(event.logIndex),
      blockNumber: event.blockNumber ?? existingRow.blockNumber,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(walletLedgerEvents.id, existingRow.id),
        eq(walletLedgerEvents.walletAddress, walletAddress)
      )
    );
  return true;
}

export async function backfillMissingCanonicalIdentities(
  wallet: string,
  events: WalletLedgerEvent[],
  index: PersistedAuthoritativeIndex
): Promise<CanonicalBackfillResult> {
  let backfilled = 0;
  let skippedAlreadyPresent = 0;

  for (const event of events) {
    const mergeKey = authoritativeEventMergeKey(assignChainEventDedupeKey(event));
    if (index.mergeKeys.has(mergeKey)) {
      skippedAlreadyPresent += 1;
      continue;
    }
    if (!hasCanonicalChainLogCoordinates(event)) continue;

    const physicalKey = physicalLogKey(event.txHash!, event.logIndex!);
    const byPhysical = index.byPhysicalLog.get(physicalKey);
    if (byPhysical && isSamePhysicalChainLog(event, byPhysical)) {
      await backfillCanonicalIdentityOnLegacyRow(wallet, event, byPhysical);
      for (const key of mergeKeysForPersistedRow({
        ...byPhysical,
        canonicalIdentity: buildCanonicalChainLogIdentity({
          txHash: event.txHash!,
          logIndex: event.logIndex!,
        }),
        logIndex: event.logIndex!,
        txHash: event.txHash!,
      })) {
        index.mergeKeys.add(key);
      }
      index.byCanonicalIdentity.set(
        buildCanonicalChainLogIdentity({
          txHash: event.txHash!,
          logIndex: event.logIndex!,
        }),
        byPhysical
      );
      backfilled += 1;
      continue;
    }

    const byDedupe = index.byDedupeKey.get(event.dedupeKey);
    if (byDedupe && isSamePhysicalChainLog(event, byDedupe)) {
      await backfillCanonicalIdentityOnLegacyRow(wallet, event, byDedupe);
      backfilled += 1;
      for (const key of mergeKeysForPersistedRow({
        ...byDedupe,
        canonicalIdentity: buildCanonicalChainLogIdentity({
          txHash: event.txHash!,
          logIndex: event.logIndex!,
        }),
        logIndex: event.logIndex!,
        txHash: event.txHash!,
      })) {
        index.mergeKeys.add(key);
      }
    }
  }

  return { backfilled, skippedAlreadyPresent };
}

export function assertNoLegacyDedupeKeyCollision(
  event: WalletLedgerEvent,
  index: PersistedAuthoritativeIndex
): void {
  const existing = index.byDedupeKey.get(event.dedupeKey);
  if (!existing) return;
  if (isSamePhysicalChainLog(event, existing)) return;

  const incomingPhysical = hasCanonicalChainLogCoordinates(event)
    ? physicalLogKey(event.txHash!, event.logIndex!)
    : event.dedupeKey;
  const existingPhysical =
    existing.txHash && existing.logIndex != null
      ? physicalLogKey(existing.txHash, existing.logIndex)
      : null;

  throw new LegacyDedupeKeyCollisionError({
    dedupeKey: event.dedupeKey,
    incomingCanonicalIdentity: authoritativeEventMergeKey(
      assignChainEventDedupeKey(event)
    ),
    existingRowId: existing.id,
    existingPhysicalLog: existingPhysical,
    incomingPhysicalLog: incomingPhysical,
  });
}
