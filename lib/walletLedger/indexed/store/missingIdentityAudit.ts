import {
  assignChainEventDedupeKey,
  authoritativeEventMergeKey,
  classifyChainEventIdentity,
  resolveAuthoritativeChainIdentity,
} from "@/lib/walletLedger/canonicalChainIdentity";
import {
  filterChainAuthoritativeEvents,
  filterPersistableAuthoritativeEvents,
  isPersistableAuthoritativeEvent,
} from "@/lib/walletLedger/indexed/store/authoritativePersistence";
import {
  isSamePhysicalChainLog,
  loadPersistedAuthoritativeIndex,
  physicalLogKey,
  type PersistedLedgerRowRef,
} from "@/lib/walletLedger/indexed/store/persistedAuthoritativeIndex";
import type { WalletLedgerEvent } from "@/lib/walletLedger/types";

export type MissingIdentityBucket =
  | "A"
  | "B"
  | "C"
  | "D"
  | "E"
  | "F"
  | "G";

export interface MissingIdentityReport {
  canonicalIdentity: string | null;
  dedupeKey: string;
  txHash: string | null;
  logIndex: number | null;
  blockNumber: number | null;
  contract: string | null;
  asset: string;
  action: string;
  sourceClass: string;
  bucket: MissingIdentityBucket;
  dbRowWithCanonicalIdentity: boolean;
  dbRowWithDedupeKey: boolean;
  dbRowWithTxLogIndex: boolean;
  insertAttempted: boolean;
  sqlConflictTarget: string | null;
  sqlConflictReason: string | null;
  whyStillMissing: string;
  existingRowId: number | null;
}

function findByTxLog(
  index: Awaited<ReturnType<typeof loadPersistedAuthoritativeIndex>>,
  event: WalletLedgerEvent
): PersistedLedgerRowRef | undefined {
  if (!event.txHash || event.logIndex == null) return undefined;
  return index.byPhysicalLog.get(physicalLogKey(event.txHash, event.logIndex));
}

export function classifyMissingAuthoritativeIdentity(
  event: WalletLedgerEvent,
  index: Awaited<ReturnType<typeof loadPersistedAuthoritativeIndex>>,
  opts: { insertAttempted?: boolean } = {}
): MissingIdentityReport {
  const normalized = assignChainEventDedupeKey(event);
  const canonicalIdentity = resolveAuthoritativeChainIdentity(normalized);
  const mergeKey = authoritativeEventMergeKey(normalized);
  const sourceClass = classifyChainEventIdentity(normalized);
  const byCanonical =
    canonicalIdentity != null
      ? index.byCanonicalIdentity.get(canonicalIdentity)
      : undefined;
  const byDedupe = index.byDedupeKey.get(normalized.dedupeKey);
  const byTxLog = findByTxLog(index, normalized);

  let bucket: MissingIdentityBucket = "G";
  let sqlConflictTarget: string | null = null;
  let sqlConflictReason: string | null = null;
  let whyStillMissing = "unknown";
  let existingRowId: number | null = null;

  if (!isPersistableAuthoritativeEvent(normalized)) {
    bucket = "D";
    whyStillMissing =
      "unresolved_chain_log excluded from persistable baseline denominator";
  } else if (index.mergeKeys.has(mergeKey)) {
    bucket = "E";
    whyStillMissing =
      "merge key present in persisted index but excluded from missing set upstream";
  } else if (byTxLog && isSamePhysicalChainLog(normalized, byTxLog)) {
    bucket = "A";
    existingRowId = byTxLog.id;
    whyStillMissing =
      "same physical log exists under legacy dedupe_key without canonical_identity backfill";
    if (byDedupe && byDedupe.id === byTxLog.id) {
      sqlConflictTarget = "dedupe_key";
      sqlConflictReason = "legacy row blocks insert; canonical_identity not backfilled";
    }
  } else if (byDedupe && !isSamePhysicalChainLog(normalized, byDedupe)) {
    bucket = "B";
    existingRowId = byDedupe.id;
    sqlConflictTarget = "dedupe_key";
    sqlConflictReason = "legacy dedupe_key UNIQUE occupied by different physical log";
    whyStillMissing =
      "dedupe_key collision with different physical chain log blocks canonical insert";
  } else if (byCanonical && !isSamePhysicalChainLog(normalized, byCanonical)) {
    bucket = "C";
    existingRowId = byCanonical.id;
    sqlConflictTarget = "canonical_identity";
    sqlConflictReason = "canonical_identity occupied by different physical log";
    whyStillMissing = "canonical_identity unique conflict with different physical log";
  } else if (
    canonicalIdentity == null &&
    sourceClass === "recoverable_chain_log"
  ) {
    bucket = "F";
    whyStillMissing =
      "recoverable chain log missing durable log_index coordinates for canonical identity";
  } else if (byDedupe) {
    bucket = "F";
    existingRowId = byDedupe.id;
    whyStillMissing = "dedupe_key row exists but canonical merge key mismatch";
  } else {
    bucket = "G";
    whyStillMissing = "no durable row and no recognized collision path";
  }

  return {
    canonicalIdentity,
    dedupeKey: normalized.dedupeKey,
    txHash: normalized.txHash ?? null,
    logIndex: normalized.logIndex ?? null,
    blockNumber: normalized.blockNumber ?? null,
    contract: null,
    asset: normalized.asset,
    action: normalized.type,
    sourceClass,
    bucket,
    dbRowWithCanonicalIdentity: byCanonical != null,
    dbRowWithDedupeKey: byDedupe != null,
    dbRowWithTxLogIndex: byTxLog != null,
    insertAttempted: opts.insertAttempted ?? false,
    sqlConflictTarget,
    sqlConflictReason,
    whyStillMissing,
    existingRowId,
  };
}

export async function auditMissingAuthoritativeIdentities(
  wallet: string,
  authoritativeEvents: WalletLedgerEvent[]
): Promise<{
  missing: MissingIdentityReport[];
  summary: Record<MissingIdentityBucket, number>;
  persistableMissing: number;
  classDExcluded: number;
}> {
  const index = await loadPersistedAuthoritativeIndex(wallet);
  const authoritative = filterChainAuthoritativeEvents(authoritativeEvents);
  const persistable = filterPersistableAuthoritativeEvents(authoritativeEvents);
  const missing: MissingIdentityReport[] = [];

  for (const event of persistable) {
    const mergeKey = authoritativeEventMergeKey(assignChainEventDedupeKey(event));
    if (!index.mergeKeys.has(mergeKey)) {
      missing.push(classifyMissingAuthoritativeIdentity(event, index));
    }
  }

  const summary: Record<MissingIdentityBucket, number> = {
    A: 0,
    B: 0,
    C: 0,
    D: 0,
    E: 0,
    F: 0,
    G: 0,
  };
  for (const row of missing) {
    summary[row.bucket] += 1;
  }

  return {
    missing,
    summary,
    persistableMissing: missing.length,
    classDExcluded: authoritative.length - persistable.length,
  };
}
