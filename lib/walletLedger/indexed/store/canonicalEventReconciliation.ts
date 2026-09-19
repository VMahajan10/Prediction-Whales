import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/crossmarket/store/db";
import { walletLedgerEvents } from "@/lib/crossmarket/store/schema";
import {
  assignChainEventDedupeKey,
  authoritativeEventMergeKey,
  buildCanonicalChainLogIdentity,
  hasCanonicalChainLogCoordinates,
  ledgerFieldConflicts,
} from "@/lib/walletLedger/canonicalChainIdentity";
import { normalizeWalletAddress } from "@/lib/walletLedger/indexed/store/persistWalletHistory";
import {
  type PersistedAuthoritativeIndex,
  type PersistedLedgerRowRef,
  backfillCanonicalIdentityOnLegacyRow,
  isSamePhysicalChainLog,
  loadPersistedAuthoritativeIndex,
  mergeKeysForPersistedRow,
  physicalLogKey,
} from "@/lib/walletLedger/indexed/store/persistedAuthoritativeIndex";
import { persistedCanonicalMatchKey } from "@/lib/walletLedger/indexed/store/canonicalIdentityPersist";
import type { WalletLedgerEvent } from "@/lib/walletLedger/types";

const FLOAT_EPSILON = 1e-9;

export interface CanonicalReconciliationDiagnostics {
  canonicalMatches: number;
  physicalCoordinateMatches: number;
  canonicalDedupeKeyBackfills: number;
  legacyCoordinateBackfills: number;
  newCanonicalInserts: number;
  ambiguousCollisions: number;
  economicConflicts: number;
  crossWalletDedupeSatisfied: number;
}

export function parseCanonicalChainDedupeKey(
  dedupeKey: string
): { chainId: string; txHash: string; logIndex: number } | null {
  const parts = dedupeKey.split("|");
  if (parts[0] !== "chain" || parts.length < 4) return null;
  const chainId = parts[1] ?? "";
  const txHash = parts[2] ?? "";
  const logIndex = Number.parseInt(parts[3] ?? "", 10);
  if (!txHash.startsWith("0x") || !Number.isFinite(logIndex) || logIndex < 0) {
    return null;
  }
  return { chainId, txHash, logIndex };
}

function floatEqual(
  a: number | null | undefined,
  b: number | null | undefined
): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return Math.abs(a - b) <= FLOAT_EPSILON;
}

export function persistedRowToEvent(
  row: PersistedLedgerRowRef,
  wallet: string
): WalletLedgerEvent {
  return assignChainEventDedupeKey({
    wallet,
    conditionId: "",
    asset: row.assetId ?? "",
    timestamp: 0,
    type: row.eventType as WalletLedgerEvent["type"],
    shares: row.shares ?? undefined,
    cashUsd: row.cashUsd ?? undefined,
    txHash: row.txHash ?? undefined,
    logIndex: row.logIndex ?? undefined,
    blockNumber: row.blockNumber ?? undefined,
    dedupeKey: row.dedupeKey,
    source: (row.source ?? "polygon") as WalletLedgerEvent["source"],
  });
}

export function economicFieldsAgree(
  event: WalletLedgerEvent,
  row: PersistedLedgerRowRef
): boolean {
  const rowEvent = persistedRowToEvent(row, event.wallet);
  const conflicts = ledgerFieldConflicts(event, rowEvent);
  if (conflicts.length > 0) return false;
  if (event.type !== row.eventType) return false;
  if (event.asset && row.assetId && event.asset !== row.assetId) return false;
  if (!floatEqual(event.shares, row.shares)) return false;
  if (!floatEqual(event.cashUsd, row.cashUsd)) return false;
  return true;
}

function registerRowInIndex(
  index: PersistedAuthoritativeIndex,
  row: PersistedLedgerRowRef
): void {
  index.byDedupeKey.set(row.dedupeKey, row);
  if (row.canonicalIdentity?.trim()) {
    index.byCanonicalIdentity.set(row.canonicalIdentity, row);
  }
  if (row.txHash && row.logIndex != null) {
    index.byPhysicalLog.set(physicalLogKey(row.txHash, row.logIndex), row);
  }
  for (const key of mergeKeysForPersistedRow(row)) {
    index.mergeKeys.add(key);
  }
}

async function backfillCanonicalIdentityFromDedupeKey(
  wallet: string,
  row: PersistedLedgerRowRef
): Promise<PersistedLedgerRowRef | null> {
  const parsed = parseCanonicalChainDedupeKey(row.dedupeKey);
  if (!parsed) return null;
  const canonicalIdentity = buildCanonicalChainLogIdentity({
    chainId: parsed.chainId,
    txHash: parsed.txHash,
    logIndex: parsed.logIndex,
  });
  const db = getDb();
  const walletAddress = normalizeWalletAddress(wallet);
  await db
    .update(walletLedgerEvents)
    .set({
      canonicalIdentity,
      txHash: row.txHash ?? parsed.txHash,
      logIndex: row.logIndex != null ? String(row.logIndex) : String(parsed.logIndex),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(walletLedgerEvents.id, row.id),
        eq(walletLedgerEvents.walletAddress, walletAddress)
      )
    );
  return {
    ...row,
    canonicalIdentity,
    txHash: row.txHash ?? parsed.txHash,
    logIndex: row.logIndex ?? parsed.logIndex,
  };
}

export async function bulkBackfillCanonicalIdentityFromDedupeKeys(
  wallet: string
): Promise<number> {
  const db = getDb();
  const walletAddress = normalizeWalletAddress(wallet);
  const result = await db.execute(sql`
    UPDATE wallet_ledger_events
    SET
      canonical_identity = dedupe_key,
      updated_at = now()
    WHERE lower(wallet_address) = ${walletAddress}
      AND dedupe_key LIKE 'chain|137|%'
      AND canonical_identity IS NULL
      AND tx_hash IS NOT NULL
      AND log_index IS NOT NULL
  `);
  return Number(result.rowCount ?? 0);
}

export type ReconcileOutcome =
  | { kind: "satisfied" }
  | { kind: "insert" }
  | { kind: "economic_conflict"; dedupeKey: string; rowId: number }
  | { kind: "ambiguous_collision"; dedupeKey: string; rowId: number };

export async function reconcileAuthoritativeEventBeforeInsert(
  wallet: string,
  event: WalletLedgerEvent,
  index: PersistedAuthoritativeIndex,
  diagnostics: CanonicalReconciliationDiagnostics
): Promise<ReconcileOutcome> {
  const mergeKey = persistedCanonicalMatchKey(event);
  if (index.mergeKeys.has(mergeKey)) {
    diagnostics.canonicalMatches += 1;
    return { kind: "satisfied" };
  }

  const existingByDedupe = index.byDedupeKey.get(event.dedupeKey);
  if (existingByDedupe && !hasCanonicalChainLogCoordinates(event)) {
    diagnostics.canonicalMatches += 1;
    registerRowInIndex(index, existingByDedupe);
    return { kind: "satisfied" };
  }

  if (!hasCanonicalChainLogCoordinates(event)) {
    diagnostics.newCanonicalInserts += 1;
    return { kind: "insert" };
  }

  const canonicalIdentity = buildCanonicalChainLogIdentity({
    txHash: event.txHash!,
    logIndex: event.logIndex!,
  });
  const physicalKey = physicalLogKey(event.txHash!, event.logIndex!);

  const byCanonical = index.byCanonicalIdentity.get(canonicalIdentity);
  if (byCanonical) {
    if (!economicFieldsAgree(event, byCanonical)) {
      diagnostics.economicConflicts += 1;
      return {
        kind: "economic_conflict",
        dedupeKey: event.dedupeKey,
        rowId: byCanonical.id,
      };
    }
    diagnostics.canonicalMatches += 1;
    registerRowInIndex(index, byCanonical);
    return { kind: "satisfied" };
  }

  const byPhysical = index.byPhysicalLog.get(physicalKey);
  if (byPhysical) {
    if (!economicFieldsAgree(event, byPhysical)) {
      diagnostics.economicConflicts += 1;
      return {
        kind: "economic_conflict",
        dedupeKey: event.dedupeKey,
        rowId: byPhysical.id,
      };
    }
    if (!byPhysical.canonicalIdentity) {
      await backfillCanonicalIdentityOnLegacyRow(wallet, event, byPhysical);
      diagnostics.physicalCoordinateMatches += 1;
      const updated = {
        ...byPhysical,
        canonicalIdentity,
        txHash: event.txHash!,
        logIndex: event.logIndex!,
      };
      registerRowInIndex(index, updated);
      return { kind: "satisfied" };
    }
    diagnostics.physicalCoordinateMatches += 1;
    registerRowInIndex(index, byPhysical);
    return { kind: "satisfied" };
  }

  const byDedupe = index.byDedupeKey.get(event.dedupeKey);
  if (byDedupe) {
    const parsed = parseCanonicalChainDedupeKey(byDedupe.dedupeKey);
    const dedupeKeyCoords =
      parsed != null
        ? {
            txHash: parsed.txHash.toLowerCase(),
            logIndex: parsed.logIndex,
          }
        : null;
    const eventCoords = {
      txHash: event.txHash!.toLowerCase(),
      logIndex: event.logIndex!,
    };
    const rowHasCoords = byDedupe.txHash != null && byDedupe.logIndex != null;
    const rowCoords = rowHasCoords
      ? {
          txHash: byDedupe.txHash!.toLowerCase(),
          logIndex: byDedupe.logIndex!,
        }
      : null;

    if (
      dedupeKeyCoords &&
      rowCoords &&
      (rowCoords.txHash !== dedupeKeyCoords.txHash ||
        rowCoords.logIndex !== dedupeKeyCoords.logIndex)
    ) {
      diagnostics.ambiguousCollisions += 1;
      return {
        kind: "ambiguous_collision",
        dedupeKey: event.dedupeKey,
        rowId: byDedupe.id,
      };
    }

    const samePhysical =
      isSamePhysicalChainLog(event, byDedupe) ||
      (dedupeKeyCoords != null &&
        dedupeKeyCoords.txHash === eventCoords.txHash &&
        dedupeKeyCoords.logIndex === eventCoords.logIndex);
    if (samePhysical) {
      if (!economicFieldsAgree(event, byDedupe)) {
        diagnostics.economicConflicts += 1;
        return {
          kind: "economic_conflict",
          dedupeKey: event.dedupeKey,
          rowId: byDedupe.id,
        };
      }
      if (!byDedupe.canonicalIdentity) {
        const updated =
          (await backfillCanonicalIdentityFromDedupeKey(wallet, byDedupe)) ??
          byDedupe;
        await backfillCanonicalIdentityOnLegacyRow(wallet, event, updated);
        diagnostics.canonicalDedupeKeyBackfills += 1;
        registerRowInIndex(index, {
          ...updated,
          canonicalIdentity,
          txHash: event.txHash!,
          logIndex: event.logIndex!,
        });
        return { kind: "satisfied" };
      }
      diagnostics.canonicalDedupeKeyBackfills += 1;
      registerRowInIndex(index, byDedupe);
      return { kind: "satisfied" };
    }
    diagnostics.ambiguousCollisions += 1;
    return {
      kind: "ambiguous_collision",
      dedupeKey: event.dedupeKey,
      rowId: byDedupe.id,
    };
  }

  diagnostics.newCanonicalInserts += 1;
  return { kind: "insert" };
}

export async function preflightCanonicalReconciliation(
  wallet: string,
  events: WalletLedgerEvent[]
): Promise<{
  diagnostics: CanonicalReconciliationDiagnostics;
  eventsToInsert: WalletLedgerEvent[];
  blocked: boolean;
  blockReason?: string;
}> {
  const diagnostics: CanonicalReconciliationDiagnostics = {
    canonicalMatches: 0,
    physicalCoordinateMatches: 0,
    canonicalDedupeKeyBackfills: 0,
    legacyCoordinateBackfills: 0,
    newCanonicalInserts: 0,
    ambiguousCollisions: 0,
    economicConflicts: 0,
    crossWalletDedupeSatisfied: 0,
  };

  await bulkBackfillCanonicalIdentityFromDedupeKeys(wallet);
  let index = await loadPersistedAuthoritativeIndex(wallet);
  const eventsToInsert: WalletLedgerEvent[] = [];

  for (const event of events) {
    const outcome = await reconcileAuthoritativeEventBeforeInsert(
      wallet,
      event,
      index,
      diagnostics
    );
    if (outcome.kind === "insert") {
      eventsToInsert.push(event);
      continue;
    }
    if (outcome.kind === "economic_conflict") {
      return {
        diagnostics,
        eventsToInsert,
        blocked: true,
        blockReason: `economic_conflict dedupeKey=${outcome.dedupeKey} rowId=${outcome.rowId}`,
      };
    }
    if (outcome.kind === "ambiguous_collision") {
      return {
        diagnostics,
        eventsToInsert,
        blocked: true,
        blockReason: `ambiguous_collision dedupeKey=${outcome.dedupeKey} rowId=${outcome.rowId}`,
      };
    }
  }

  return { diagnostics, eventsToInsert, blocked: false };
}

export function createEmptyReconciliationDiagnostics(): CanonicalReconciliationDiagnostics {
  return {
    canonicalMatches: 0,
    physicalCoordinateMatches: 0,
    canonicalDedupeKeyBackfills: 0,
    legacyCoordinateBackfills: 0,
    newCanonicalInserts: 0,
    ambiguousCollisions: 0,
    economicConflicts: 0,
    crossWalletDedupeSatisfied: 0,
  };
}
