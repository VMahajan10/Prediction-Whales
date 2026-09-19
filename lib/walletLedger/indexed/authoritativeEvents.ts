import {
  authoritativeEventMergeKey,
  ledgerFieldConflicts as canonicalLedgerFieldConflicts,
} from "@/lib/walletLedger/canonicalChainIdentity";
import type { PersistedCoverageSnapshot } from "@/lib/walletLedger/indexed/indexedCredibility";
import { mergeChainOrderFields } from "@/lib/walletLedger/eventOrder";
import { POLYMARKET_EXCHANGE_INITIAL_BLOCK } from "@/lib/walletLedger/onchain/contracts";
import type { WalletLedgerEvent } from "@/lib/walletLedger/types";

export const HISTORICAL_BACKFILL_REQUIRED = "historical_backfill_required";

/** Checkpoint/event counts below this fraction of persisted DB are treated as sparse. */
export const SPARSE_CHECKPOINT_VS_DB_RATIO = 0.85;

export interface AuthoritativeMergeDiagnostics {
  duplicateEventsMerged: number;
  timestampUpgrades: number;
  timestampConflicts: number;
  ledgerFieldConflicts: number;
  timestampConflictSamples: Array<{
    dedupeKey: string;
    blockNumber: number | null;
    persistedTimestamp: number;
    deltaTimestamp: number;
  }>;
  ledgerFieldConflictSamples: Array<{
    dedupeKey: string;
    fields: string[];
  }>;
}

export interface AuthoritativeEventMergeStats {
  persistedDbEventCount: number;
  deltaEventCount: number;
  newDeltaEvents: number;
  duplicateDeltaEvents: number;
  checkpointEventCount: number;
  authoritativeEventCount: number;
  usedPersistedDbBase: boolean;
  checkpointSparse: boolean;
  duplicateEventsMerged?: number;
  timestampUpgrades?: number;
  timestampConflicts?: number;
  ledgerFieldConflicts?: number;
}

const MAX_MERGE_DIAGNOSTIC_SAMPLES = 10;

function createEmptyMergeDiagnostics(): AuthoritativeMergeDiagnostics {
  return {
    duplicateEventsMerged: 0,
    timestampUpgrades: 0,
    timestampConflicts: 0,
    ledgerFieldConflicts: 0,
    timestampConflictSamples: [],
    ledgerFieldConflictSamples: [],
  };
}

function hasValidTimestamp(event: WalletLedgerEvent): boolean {
  return Number.isFinite(event.timestamp) && event.timestamp > 0;
}

function ledgerIdentityConflicts(
  left: WalletLedgerEvent,
  right: WalletLedgerEvent
): string[] {
  return canonicalLedgerFieldConflicts(left, right);
}

function mergeComplementaryEventFields(
  primary: WalletLedgerEvent,
  secondary: WalletLedgerEvent
): WalletLedgerEvent {
  const timestamp = hasValidTimestamp(primary)
    ? primary.timestamp
    : hasValidTimestamp(secondary)
      ? secondary.timestamp
      : primary.timestamp;
  const chainOrder = mergeChainOrderFields(primary, secondary);
  const merged = {
    ...primary,
    wallet: primary.wallet,
    type: primary.type,
    source: primary.source,
    timestamp,
    blockNumber: chainOrder.blockNumber,
    logIndex: chainOrder.logIndex,
    transactionIndex: chainOrder.transactionIndex,
    txHash: primary.txHash ?? secondary.txHash,
    shares: primary.shares ?? secondary.shares,
    cashUsd: primary.cashUsd ?? secondary.cashUsd,
    price: primary.price ?? secondary.price,
    conditionId: primary.conditionId || secondary.conditionId,
    asset: primary.asset || secondary.asset,
    title: primary.title ?? secondary.title,
    slug: primary.slug ?? secondary.slug,
    outcome: primary.outcome ?? secondary.outcome,
    dedupeKey: primary.dedupeKey,
  };
  return {
    ...merged,
    dedupeKey: authoritativeEventMergeKey(merged),
  };
}

function recordLedgerFieldConflict(
  diagnostics: AuthoritativeMergeDiagnostics,
  dedupeKey: string,
  fields: string[]
): void {
  diagnostics.ledgerFieldConflicts += 1;
  if (diagnostics.ledgerFieldConflictSamples.length >= MAX_MERGE_DIAGNOSTIC_SAMPLES) {
    return;
  }
  diagnostics.ledgerFieldConflictSamples.push({ dedupeKey, fields });
}

function recordTimestampConflict(
  diagnostics: AuthoritativeMergeDiagnostics,
  dedupeKey: string,
  blockNumber: number | null,
  persistedTimestamp: number,
  deltaTimestamp: number
): void {
  diagnostics.timestampConflicts += 1;
  if (diagnostics.timestampConflictSamples.length >= MAX_MERGE_DIAGNOSTIC_SAMPLES) {
    return;
  }
  diagnostics.timestampConflictSamples.push({
    dedupeKey,
    blockNumber,
    persistedTimestamp,
    deltaTimestamp,
  });
}

function hydrateEventTimestamp(
  event: WalletLedgerEvent,
  supplements: AuthoritativeMergeSupplements | undefined,
  diagnostics: AuthoritativeMergeDiagnostics
): WalletLedgerEvent {
  if (hasValidTimestamp(event) || !supplements) {
    return event;
  }
  const txHash = event.txHash?.toLowerCase();
  if (txHash) {
    const byTx = supplements.timestampsByTxHash.get(txHash);
    if (byTx != null && byTx > 0) {
      diagnostics.timestampUpgrades += 1;
      return { ...event, timestamp: byTx };
    }
  }
  if (event.blockNumber != null) {
    const byBlock = supplements.timestampsByBlock.get(event.blockNumber);
    if (byBlock != null && byBlock > 0) {
      diagnostics.timestampUpgrades += 1;
      return { ...event, timestamp: byBlock };
    }
  }
  return event;
}

export interface AuthoritativeMergeSupplements {
  timestampsByBlock: Map<number, number>;
  timestampsByTxHash: Map<string, number>;
}

export function buildAuthoritativeMergeSupplements(input: {
  blockTimestamps?: Map<number, number>;
  verifiedTradeEvidence?: Array<{
    txHash: string;
    verifiedOnPolygon: boolean;
    blockNumber: number | null;
    blockTimestamp: number | null;
  }>;
}): AuthoritativeMergeSupplements {
  const timestampsByBlock = new Map(input.blockTimestamps ?? []);
  const timestampsByTxHash = new Map<string, number>();
  for (const evidence of input.verifiedTradeEvidence ?? []) {
    if (
      evidence.verifiedOnPolygon &&
      evidence.blockNumber != null &&
      evidence.blockTimestamp != null &&
      evidence.blockTimestamp > 0
    ) {
      timestampsByBlock.set(evidence.blockNumber, evidence.blockTimestamp);
      timestampsByTxHash.set(evidence.txHash.toLowerCase(), evidence.blockTimestamp);
    }
  }
  return { timestampsByBlock, timestampsByTxHash };
}

function resolveDuplicateAuthoritativeEvents(
  existing: WalletLedgerEvent,
  incoming: WalletLedgerEvent,
  diagnostics: AuthoritativeMergeDiagnostics,
  supplements?: AuthoritativeMergeSupplements
): WalletLedgerEvent {
  diagnostics.duplicateEventsMerged += 1;

  const identityConflicts = ledgerIdentityConflicts(existing, incoming);
  if (identityConflicts.length > 0) {
    recordLedgerFieldConflict(diagnostics, existing.dedupeKey, identityConflicts);
  }

  const existingValid = hasValidTimestamp(existing);
  const incomingValid = hasValidTimestamp(incoming);

  if (!existingValid && incomingValid) {
    diagnostics.timestampUpgrades += 1;
    return mergeComplementaryEventFields(incoming, existing);
  }
  if (existingValid && !incomingValid) {
    return hydrateEventTimestamp(
      mergeComplementaryEventFields(existing, incoming),
      supplements,
      diagnostics
    );
  }
  if (existingValid && incomingValid) {
    if (existing.timestamp === incoming.timestamp) {
      return mergeComplementaryEventFields(existing, incoming);
    }
    const sameBlock =
      existing.blockNumber != null &&
      incoming.blockNumber != null &&
      existing.blockNumber === incoming.blockNumber;
    if (sameBlock) {
      recordTimestampConflict(
        diagnostics,
        existing.dedupeKey,
        existing.blockNumber ?? null,
        existing.timestamp,
        incoming.timestamp
      );
      return mergeComplementaryEventFields(existing, incoming);
    }
    recordTimestampConflict(
      diagnostics,
      existing.dedupeKey,
      existing.blockNumber ?? incoming.blockNumber ?? null,
      existing.timestamp,
      incoming.timestamp
    );
    return mergeComplementaryEventFields(existing, incoming);
  }

  return hydrateEventTimestamp(
    mergeComplementaryEventFields(existing, incoming),
    supplements,
    diagnostics
  );
}

export function mergeAuthoritativeIndexedEventsWithDiagnostics(
  persistedDbEvents: WalletLedgerEvent[],
  deltaIndexedEvents: WalletLedgerEvent[],
  options?: { supplements?: AuthoritativeMergeSupplements }
): { events: WalletLedgerEvent[]; diagnostics: AuthoritativeMergeDiagnostics } {
  const diagnostics = createEmptyMergeDiagnostics();
  const byKey = new Map<string, WalletLedgerEvent>();
  const keyOrder: string[] = [];

  const upsert = (incoming: WalletLedgerEvent) => {
    const mergeKey = authoritativeEventMergeKey(incoming);
    const existing = byKey.get(mergeKey);
    if (!existing) {
      const hydrated = hydrateEventTimestamp(
        { ...incoming, dedupeKey: mergeKey },
        options?.supplements,
        diagnostics
      );
      byKey.set(mergeKey, hydrated);
      keyOrder.push(mergeKey);
      return;
    }
    byKey.set(
      mergeKey,
      resolveDuplicateAuthoritativeEvents(
        existing,
        { ...incoming, dedupeKey: mergeKey },
        diagnostics,
        options?.supplements
      )
    );
  };

  for (const event of persistedDbEvents) upsert(event);
  for (const event of deltaIndexedEvents) upsert(event);

  return {
    events: keyOrder.map((key) => byKey.get(key)!),
    diagnostics,
  };
}

export interface CoverageConsistencyAssessment {
  sufficient: boolean;
  historicalBackfillRequired: boolean;
  checkpointSparse: boolean;
  persistedDbEventCount: number;
  checkpointEventCount: number;
  reason?: string;
}

export interface MonotonicCoverageFields {
  extendsBeforeApiBoundary: boolean;
  eventsBeforeApiBoundary: number;
  indexedOldestTimestamp: number | null;
  lastIndexedBlock: number;
  lastReconstructedBlock: number;
}

export function mergeAuthoritativeIndexedEvents(
  persistedDbEvents: WalletLedgerEvent[],
  deltaIndexedEvents: WalletLedgerEvent[]
): WalletLedgerEvent[] {
  return mergeAuthoritativeIndexedEventsWithDiagnostics(
    persistedDbEvents,
    deltaIndexedEvents
  ).events;
}

export function resolveIncrementalFromBlock(input: {
  fullHistory: boolean;
  lastIndexedBlock: number | null;
  persistedEventCount: number;
  headBlock: number;
  maxBlocksToScan: number;
}): number {
  if (input.persistedEventCount > 0 && input.lastIndexedBlock != null && input.lastIndexedBlock > 0) {
    return input.lastIndexedBlock + 1;
  }
  if (input.fullHistory) {
    return POLYMARKET_EXCHANGE_INITIAL_BLOCK;
  }
  return Math.max(
    POLYMARKET_EXCHANGE_INITIAL_BLOCK,
    input.headBlock - input.maxBlocksToScan
  );
}

export function isCheckpointHistorySparse(input: {
  persistedDbEventCount: number;
  checkpointEventCount: number;
}): boolean {
  if (input.persistedDbEventCount <= 0) return false;
  if (input.checkpointEventCount <= 0) return true;
  return (
    input.checkpointEventCount <
    input.persistedDbEventCount * SPARSE_CHECKPOINT_VS_DB_RATIO
  );
}

export function assessCoverageConsistency(input: {
  persistedDbEventCount: number;
  checkpointEventCount: number;
  persistedCoverage: PersistedCoverageSnapshot | null;
  fullHistory: boolean;
}): CoverageConsistencyAssessment {
  const checkpointSparse = isCheckpointHistorySparse({
    persistedDbEventCount: input.persistedDbEventCount,
    checkpointEventCount: input.checkpointEventCount,
  });

  if (input.persistedDbEventCount > 0) {
    return {
      sufficient: true,
      historicalBackfillRequired: false,
      checkpointSparse,
      persistedDbEventCount: input.persistedDbEventCount,
      checkpointEventCount: input.checkpointEventCount,
      reason: checkpointSparse ? "using_persisted_db_over_sparse_checkpoint" : undefined,
    };
  }

  const persistedProvenPreApi =
    input.persistedCoverage != null &&
    (input.persistedCoverage.extendsBeforeApiBoundary === true ||
      input.persistedCoverage.eventsBeforeApiBoundary > 0);

  if (input.fullHistory && !persistedProvenPreApi && input.checkpointEventCount === 0) {
    return {
      sufficient: false,
      historicalBackfillRequired: true,
      checkpointSparse: true,
      persistedDbEventCount: 0,
      checkpointEventCount: input.checkpointEventCount,
      reason: HISTORICAL_BACKFILL_REQUIRED,
    };
  }

  return {
    sufficient: input.checkpointEventCount > 0 || persistedProvenPreApi,
    historicalBackfillRequired: !input.checkpointEventCount && !persistedProvenPreApi,
    checkpointSparse,
    persistedDbEventCount: input.persistedDbEventCount,
    checkpointEventCount: input.checkpointEventCount,
    reason:
      !input.checkpointEventCount && !persistedProvenPreApi
        ? HISTORICAL_BACKFILL_REQUIRED
        : undefined,
  };
}

function minFinite(values: number[]): number | null {
  if (values.length === 0) return null;
  let min = values[0]!;
  for (let i = 1; i < values.length; i += 1) {
    const value = values[i]!;
    if (value < min) min = value;
  }
  return min;
}

export function collectBlocksMissingTimestamps(
  events: WalletLedgerEvent[]
): Set<number> {
  const blocks = new Set<number>();
  for (const event of events) {
    if (event.blockNumber && (!event.timestamp || event.timestamp <= 0)) {
      blocks.add(event.blockNumber);
    }
  }
  return blocks;
}

export function applyBlockTimestampsToEvents(
  events: WalletLedgerEvent[],
  timestamps: Map<number, number>
): number {
  let backfilled = 0;
  for (const event of events) {
    if (!event.blockNumber || (event.timestamp && event.timestamp > 0)) {
      continue;
    }
    const timestamp = timestamps.get(event.blockNumber);
    if (timestamp && timestamp > 0) {
      event.timestamp = timestamp;
      backfilled += 1;
    }
  }
  return backfilled;
}

export function computeIndexedBoundaryStats(
  authoritativeIndexedEvents: WalletLedgerEvent[],
  apiOldestTimestamp: number | null
): {
  indexedOldestTimestamp: number | null;
  eventsBeforeApiBoundary: number;
  extendsBeforeApiBoundary: boolean;
} {
  const indexedTs = authoritativeIndexedEvents
    .map((event) => event.timestamp)
    .filter((ts) => Number.isFinite(ts) && ts > 0);
  const indexedOldest = minFinite(indexedTs);
  const eventsBeforeApiBoundary =
    apiOldestTimestamp != null && indexedOldest != null && indexedOldest < apiOldestTimestamp
      ? authoritativeIndexedEvents.filter((event) => event.timestamp < apiOldestTimestamp).length
      : 0;
  return {
    indexedOldestTimestamp: indexedOldest,
    eventsBeforeApiBoundary,
    extendsBeforeApiBoundary: eventsBeforeApiBoundary > 0,
  };
}

export function mergeMonotonicCoverageFields(
  persisted: PersistedCoverageSnapshot | null,
  current: MonotonicCoverageFields
): MonotonicCoverageFields {
  const persistedOldest =
    persisted?.indexedOldestTimestamp != null &&
    Number.isFinite(persisted.indexedOldestTimestamp)
      ? persisted.indexedOldestTimestamp
      : null;
  const currentOldest =
    current.indexedOldestTimestamp != null &&
    Number.isFinite(current.indexedOldestTimestamp)
      ? current.indexedOldestTimestamp
      : null;

  return {
    extendsBeforeApiBoundary:
      persisted?.extendsBeforeApiBoundary === true || current.extendsBeforeApiBoundary,
    eventsBeforeApiBoundary: Math.max(
      persisted?.eventsBeforeApiBoundary ?? 0,
      current.eventsBeforeApiBoundary
    ),
    indexedOldestTimestamp:
      persistedOldest != null && currentOldest != null
        ? Math.min(persistedOldest, currentOldest)
        : persistedOldest ?? currentOldest,
    lastIndexedBlock: Math.max(
      (persisted as { lastIndexedBlock?: number } | null)?.lastIndexedBlock ?? 0,
      current.lastIndexedBlock
    ),
    lastReconstructedBlock: Math.max(
      (persisted as { lastReconstructedBlock?: number } | null)?.lastReconstructedBlock ?? 0,
      current.lastReconstructedBlock
    ),
  };
}

export function countDuplicateDeltaEvents(
  persistedDbEvents: WalletLedgerEvent[],
  deltaIndexedEvents: WalletLedgerEvent[]
): number {
  const persistedKeys = new Set(
    persistedDbEvents.map((event) => authoritativeEventMergeKey(event))
  );
  return deltaIndexedEvents.filter((event) =>
    persistedKeys.has(authoritativeEventMergeKey(event))
  )
    .length;
}

export function buildAuthoritativeEventMergeStats(input: {
  persistedDbEventCount: number;
  deltaEventCount: number;
  duplicateDeltaEvents: number;
  checkpointEventCount: number;
  authoritativeEventCount: number;
  usedPersistedDbBase: boolean;
  mergeDiagnostics?: AuthoritativeMergeDiagnostics;
}): AuthoritativeEventMergeStats {
  return {
    ...input,
    newDeltaEvents: input.deltaEventCount - input.duplicateDeltaEvents,
    checkpointSparse: isCheckpointHistorySparse({
      persistedDbEventCount: input.persistedDbEventCount,
      checkpointEventCount: input.checkpointEventCount,
    }),
    duplicateEventsMerged: input.mergeDiagnostics?.duplicateEventsMerged,
    timestampUpgrades: input.mergeDiagnostics?.timestampUpgrades,
    timestampConflicts: input.mergeDiagnostics?.timestampConflicts,
    ledgerFieldConflicts: input.mergeDiagnostics?.ledgerFieldConflicts,
  };
}
