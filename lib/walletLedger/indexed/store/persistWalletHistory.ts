import { and, eq, sql } from "drizzle-orm";
import { getDb, isDatabaseEnabled } from "@/lib/crossmarket/store/db";
import {
  policyAProductionWalletHydration,
  walletHistoricalMetrics,
  walletHistoryCoverage,
  walletLedgerEvents,
  walletPositionLifecycles,
} from "@/lib/crossmarket/store/schema";
import type { PersistedCoverageSnapshot } from "@/lib/walletLedger/indexed/indexedCredibility";
import { mergeMonotonicCoverageFields } from "@/lib/walletLedger/indexed/authoritativeEvents";
import { withDbCircuit } from "@/lib/walletLedger/indexed/shadow/dbCircuitBreaker";
import { retryTransient } from "@/lib/walletLedger/indexed/shadow/transientRetry";
import { withDbQueryTimeout } from "@/lib/walletLedger/indexed/store/dbQueryTimeout";
import { assertPersistenceNotAborted } from "@/lib/walletLedger/indexed/store/persistenceAbort";
import { WALLET_LEDGER_VERSION, WALLET_METRIC_VERSION } from "@/lib/walletLedger/indexed/metricVersion";
import type { IndexedAuditWalletResult } from "@/lib/walletLedger/indexed/types";
import { explainHistoryCompleteness } from "@/lib/walletLedger/indexed/metricsProfile";
import {
  atomicReplaceCurrentVersionWalletLifecycles,
  emptyAtomicLifecycleReplaceStats,
  type AtomicLifecycleReplaceStats,
} from "@/lib/walletLedger/indexed/store/incrementalLifecycles";
import {
  assessAuthoritativeBaselineCompleteness,
  buildAuthoritativePersistDiagnostics,
  buildLogIndexCompletenessReport,
  countMissingAuthoritativeEvents,
  countMissingPersistableAuthoritativeEvents,
  filterChainAuthoritativeEvents,
  hashAuthoritativeEventIdentities,
  loadPersistedAuthoritativeDedupeKeys,
  resolveAuthoritativePersistenceMode,
  selectAuthoritativePersistenceCandidates,
  selectLegacyBlockIncrementalCandidates,
  type AuthoritativePersistDiagnostics,
  type LogIndexCompletenessReport,
} from "@/lib/walletLedger/indexed/store/authoritativePersistence";
import {
  preflightCanonicalReconciliation,
  type CanonicalReconciliationDiagnostics,
} from "@/lib/walletLedger/indexed/store/canonicalEventReconciliation";
import { loadPersistedAuthoritativeIndex } from "@/lib/walletLedger/indexed/store/persistedAuthoritativeIndex";
import {
  resolveChainLogCanonicalIdentityForPersist,
} from "@/lib/walletLedger/indexed/store/canonicalIdentityPersist";
import {
  countPersistedEventMetadataCoverage,
  enrichPersistedLedgerEventMetadata,
  type MetadataEnrichmentStats,
} from "@/lib/walletLedger/indexed/store/eventMetadataEnrichment";
import { loadPersistedWalletEventsPaginated } from "@/lib/walletLedger/indexed/store/persistedEventLoader";
import type { PositionLifecycle, WalletLedgerEvent } from "@/lib/walletLedger/types";

export type { AuthoritativePersistDiagnostics, LogIndexCompletenessReport };

/** Bounded insert batch size for wallet_ledger_events (scale-tested 100–500). */
export const EVENT_PERSIST_CHUNK_SIZE = 250;

export function walletHistoryDbEnabled(): boolean {
  return isDatabaseEnabled();
}

export function normalizeWalletAddress(wallet: string): string {
  return wallet.toLowerCase();
}

export async function loadPersistedCoverageSnapshot(
  wallet: string
): Promise<PersistedCoverageSnapshot | null> {
  if (!walletHistoryDbEnabled()) return null;
  const db = getDb();
  const rows = await db
    .select({
      extendsBeforeApiBoundary: walletHistoryCoverage.extendsBeforeApiBoundary,
      eventsBeforeApiBoundary: walletHistoryCoverage.eventsBeforeApiBoundary,
      indexedOldestTimestamp: walletHistoryCoverage.indexedOldestTimestamp,
      eventHistoryComplete: walletHistoryCoverage.eventHistoryComplete,
      chainId: walletHistoryCoverage.chainId,
      metricVersion: walletHistoryCoverage.metricVersion,
      provider: walletHistoryCoverage.provider,
      lastIndexedBlock: walletHistoryCoverage.lastIndexedBlock,
      lastReconstructedBlock: walletHistoryCoverage.lastReconstructedBlock,
    })
    .from(walletHistoryCoverage)
    .where(sql`${walletHistoryCoverage.walletAddress} = ${normalizeWalletAddress(wallet)}`)
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    extendsBeforeApiBoundary: row.extendsBeforeApiBoundary,
    eventsBeforeApiBoundary: row.eventsBeforeApiBoundary,
    indexedOldestTimestamp: row.indexedOldestTimestamp,
    eventHistoryComplete: row.eventHistoryComplete,
    chainId: row.chainId,
    metricVersion: row.metricVersion,
    provider: row.provider,
    lastIndexedBlock: row.lastIndexedBlock,
    lastReconstructedBlock: row.lastReconstructedBlock,
  };
}

export async function countWalletLedgerEvents(wallet: string): Promise<number> {
  const db = getDb();
  const walletAddress = normalizeWalletAddress(wallet);
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(walletLedgerEvents)
    .where(sql`${walletLedgerEvents.walletAddress} = ${walletAddress}`);
  return rows[0]?.count ?? 0;
}

export async function loadLastIndexedBlock(wallet: string): Promise<number | null> {
  if (!walletHistoryDbEnabled()) return null;
  const db = getDb();
  const rows = await db
    .select({ lastIndexedBlock: walletHistoryCoverage.lastIndexedBlock })
    .from(walletHistoryCoverage)
    .where(sql`${walletHistoryCoverage.walletAddress} = ${normalizeWalletAddress(wallet)}`)
    .limit(1);
  return rows[0]?.lastIndexedBlock ?? null;
}

/**
 * Wallet ledger chain-log identity is canonical (chain|137|tx|logIndex).
 * Legacy dedupe_key remains for compatibility; canonical_identity is written when present.
 * Inserts use ON CONFLICT DO NOTHING on dedupe_key; missing chain metadata may be enriched later.
 */
export function dedupeCandidateEvents(events: WalletLedgerEvent[]): WalletLedgerEvent[] {
  const seen = new Set<string>();
  const deduped: WalletLedgerEvent[] = [];
  for (const event of events) {
    if (seen.has(event.dedupeKey)) continue;
    seen.add(event.dedupeKey);
    deduped.push(event);
  }
  return deduped;
}

/**
 * @deprecated Use selectAuthoritativePersistenceCandidates — block cursor is not
 * proof of durable baseline completeness.
 */
export function selectPersistenceCandidateEvents(
  allEvents: WalletLedgerEvent[],
  opts: { lastIndexedBlock: number | null; throughBlock: number | null }
): WalletLedgerEvent[] {
  return selectLegacyBlockIncrementalCandidates(allEvents, opts);
}

export function planEventInsertChunks<T>(
  items: T[],
  chunkSize = EVENT_PERSIST_CHUNK_SIZE
): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize));
  }
  return chunks;
}

export async function countDuplicateDedupeKeys(): Promise<number> {
  const db = getDb();
  const rows = await db
    .select({
      dedupeKey: walletLedgerEvents.dedupeKey,
      c: sql<number>`count(*)::int`,
    })
    .from(walletLedgerEvents)
    .groupBy(walletLedgerEvents.dedupeKey)
    .having(sql`count(*) > 1`);
  return rows.length;
}

function walletLedgerEventRow(
  walletAddress: string,
  event: WalletLedgerEvent
) {
  const canonicalIdentity =
    process.env.CANONICAL_IDENTITY_MIGRATED === "1"
      ? resolveChainLogCanonicalIdentityForPersist(event)
      : undefined;
  return {
    walletAddress,
    chainId: "137",
    dedupeKey: event.dedupeKey,
    ...(canonicalIdentity != null ? { canonicalIdentity } : {}),
    txHash: event.txHash ?? null,
    logIndex:
      event.logIndex != null && event.logIndex >= 0
        ? String(event.logIndex)
        : null,
    blockNumber: event.blockNumber ?? null,
    blockTimestamp: event.timestamp > 0 ? event.timestamp : null,
    contractAddress: null,
    eventType: event.type,
    marketConditionId: event.conditionId || null,
    assetId: event.asset || null,
    side: event.type,
    shares: event.shares ?? null,
    cashUsd: event.cashUsd ?? null,
    price: event.price ?? null,
    source: event.source,
    ledgerVersion: WALLET_LEDGER_VERSION,
  };
}

export async function patchPersistedEventTimestamps(
  wallet: string,
  events: WalletLedgerEvent[]
): Promise<number> {
  const db = getDb();
  const walletAddress = normalizeWalletAddress(wallet);
  const timestampByBlock = new Map<number, number>();
  for (const event of events) {
    if (!event.blockNumber || !event.timestamp || event.timestamp <= 0) {
      continue;
    }
    timestampByBlock.set(event.blockNumber, event.timestamp);
  }
  if (timestampByBlock.size === 0) return 0;

  let patched = 0;
  for (const [blockNumber, blockTimestamp] of timestampByBlock) {
    const rows = await withDbCircuit("patchPersistedEventTimestamps", () =>
      withDbQueryTimeout("patchPersistedEventTimestamps", () =>
        db
          .update(walletLedgerEvents)
          .set({ blockTimestamp, updatedAt: new Date() })
          .where(
            and(
              eq(walletLedgerEvents.walletAddress, walletAddress),
              eq(walletLedgerEvents.blockNumber, blockNumber),
              sql`${walletLedgerEvents.blockTimestamp} IS NULL`
            )
          )
          .returning({ id: walletLedgerEvents.id })
      )
    );
    patched += rows.length;
  }
  return patched;
}

export async function upsertWalletLedgerEvents(
  wallet: string,
  events: WalletLedgerEvent[],
  options: { abortSignal?: AbortSignal } = {}
): Promise<{
  inserted: number;
  backfilled: number;
  skippedExisting: number;
  candidateEvents: number;
  attempted: number;
  chunkCount: number;
  loadExistingKeysMs: number;
  writeMs: number;
  novelEvents: WalletLedgerEvent[];
  reconciliation: CanonicalReconciliationDiagnostics;
}> {
  const candidates = dedupeCandidateEvents(events);
  const loadStarted = Date.now();
  await loadPersistedAuthoritativeIndex(wallet);
  const loadExistingKeysMs = Date.now() - loadStarted;

  const preflight = await preflightCanonicalReconciliation(wallet, candidates);
  if (preflight.blocked) {
    throw new Error(preflight.blockReason ?? "canonical_reconciliation_blocked");
  }

  const novelCandidates = preflight.eventsToInsert;
  const candidateEvents = novelCandidates.length;
  const reconciliation = preflight.diagnostics;
  const backfilled =
    reconciliation.canonicalDedupeKeyBackfills +
    reconciliation.physicalCoordinateMatches +
    reconciliation.legacyCoordinateBackfills;

  if (candidateEvents === 0) {
    return {
      inserted: 0,
      backfilled,
      skippedExisting: candidates.length,
      candidateEvents: 0,
      attempted: events.length,
      chunkCount: 0,
      loadExistingKeysMs,
      writeMs: 0,
      novelEvents: [],
      reconciliation,
    };
  }

  const db = getDb();
  const walletAddress = normalizeWalletAddress(wallet);
  const writeStarted = Date.now();
  const insertedKeys = new Set<string>();
  const chunks = planEventInsertChunks(novelCandidates);

  for (const chunk of chunks) {
    assertPersistenceNotAborted(options.abortSignal, "event-persist");
    const result = await withDbCircuit("upsertWalletLedgerEvents", () =>
      withDbQueryTimeout("upsertWalletLedgerEventsChunk", () =>
        retryTransient(
          () =>
            db
              .insert(walletLedgerEvents)
              .values(chunk.map((event) => walletLedgerEventRow(walletAddress, event)))
              .onConflictDoNothing({
                target: [
                  walletLedgerEvents.walletAddress,
                  walletLedgerEvents.dedupeKey,
                ],
              })
              .returning({ dedupeKey: walletLedgerEvents.dedupeKey }),
          { maxAttempts: 4, label: "upsertWalletLedgerEventsChunk" }
        )
      )
    );
    for (const row of result) {
      insertedKeys.add(row.dedupeKey);
    }
    const notInserted = chunk.filter((event) => !insertedKeys.has(event.dedupeKey));
    if (notInserted.length > 0) {
      const retryPreflight = await preflightCanonicalReconciliation(
        wallet,
        notInserted
      );
      if (retryPreflight.blocked) {
        throw new Error(
          retryPreflight.blockReason ?? "canonical_reconciliation_blocked"
        );
      }
      const stillMissing = retryPreflight.eventsToInsert;
      if (stillMissing.length > 0) {
        const first = stillMissing[0]!;
        throw new Error(
          `event insert skipped without durable canonical match: dedupeKey=${first.dedupeKey}`
        );
      }
    }
  }

  const inserted = insertedKeys.size;
  const skippedExisting = candidates.length - inserted - backfilled;
  const eventByKey = new Map(
    novelCandidates.map((event) => [event.dedupeKey, event])
  );
  const novelEvents = [...insertedKeys]
    .map((key) => eventByKey.get(key))
    .filter((event): event is WalletLedgerEvent => event != null);

  return {
    inserted,
    backfilled,
    skippedExisting,
    candidateEvents,
    attempted: events.length,
    chunkCount: chunks.length,
    loadExistingKeysMs,
    writeMs: Date.now() - writeStarted,
    novelEvents,
    reconciliation,
  };
}

export async function replaceWalletPositionLifecycles(
  wallet: string,
  positions: PositionLifecycle[]
): Promise<number> {
  const db = getDb();
  const walletAddress = normalizeWalletAddress(wallet);
  await db
    .delete(walletPositionLifecycles)
    .where(sql`${walletPositionLifecycles.walletAddress} = ${walletAddress} AND ${walletPositionLifecycles.metricVersion} = ${WALLET_METRIC_VERSION}`);
  if (positions.length === 0) return 0;
  const chunkSize = 50;
  for (let i = 0; i < positions.length; i += chunkSize) {
    const chunk = positions.slice(i, i + chunkSize);
    await db.insert(walletPositionLifecycles).values(
      chunk.map((p) => ({
        walletAddress,
        conditionId: p.conditionId,
        assetId: p.asset,
        metricVersion: WALLET_METRIC_VERSION,
        completed: p.completed,
        completionType: p.completionReason,
        capitalAtRisk: p.capitalAtRisk,
        buyNotional: p.grossBuyCash,
        sellNotional: p.grossSellCash,
        resolutionPayout: p.resolutionPayoutUsd,
        realizedPnl: p.realizedPnl,
        realizedRoi: p.positionRoi,
        profitable: p.realizedPnl != null ? p.realizedPnl > 0 : null,
        outcomeWin: p.outcomeCorrect,
        openedAt: p.firstEntryAt,
        completedAt: p.lastActivityAt,
        exclusionReason: p.exclusionReason,
        resolutionSource: p.resolution?.source ?? null,
        resolutionFinal: p.resolution?.resolutionFinal ?? null,
      }))
    );
  }
  return positions.length;
}

export async function upsertWalletHistoricalMetrics(
  wallet: string,
  audit: IndexedAuditWalletResult
): Promise<void> {
  const metrics = audit.indexedLedgerMetrics;
  if (!metrics) return;
  const db = getDb();
  const walletAddress = normalizeWalletAddress(wallet);
  await db
    .insert(walletHistoricalMetrics)
    .values({
      walletAddress,
      metricVersion: WALLET_METRIC_VERSION,
      completedPositions: metrics.completedPositionCount,
      medianCapitalAtRisk: metrics.medianCapitalAtRisk,
      resolvedVolumeUsd: metrics.resolvedVolumeUsd,
      profitablePositionRate: metrics.profitablePositionRate,
      outcomeWinRate: metrics.outcomeWinRate,
      realizedRoi: metrics.portfolioRealizedRoi,
      credibilityMetricsValid: metrics.credibilityMetricsValid,
      credibilityDecision: metrics.credibilityMetricsValid,
      historyValidity: metrics.historyValidity,
      historyComplete: metrics.historyComplete,
      credibilityReasons: metrics.historyCompletenessReasons,
      historyIncompleteReasons: metrics.historyCompletenessReasons,
      throughBlock: audit.throughBlock ?? null,
    })
    .onConflictDoUpdate({
      target: [
        walletHistoricalMetrics.walletAddress,
        walletHistoricalMetrics.metricVersion,
      ],
      set: {
        completedPositions: metrics.completedPositionCount,
        medianCapitalAtRisk: metrics.medianCapitalAtRisk,
        resolvedVolumeUsd: metrics.resolvedVolumeUsd,
        profitablePositionRate: metrics.profitablePositionRate,
        outcomeWinRate: metrics.outcomeWinRate,
        realizedRoi: metrics.portfolioRealizedRoi,
        credibilityMetricsValid: metrics.credibilityMetricsValid,
        credibilityDecision: metrics.credibilityMetricsValid,
        historyValidity: metrics.historyValidity,
        historyComplete: metrics.historyComplete,
        credibilityReasons: metrics.historyCompletenessReasons,
        historyIncompleteReasons: metrics.historyCompletenessReasons,
        throughBlock: audit.throughBlock ?? null,
        calculatedAt: new Date(),
      },
    });
}

export async function upsertWalletHistoryCoverage(
  wallet: string,
  audit: IndexedAuditWalletResult
): Promise<void> {
  const metrics = audit.indexedLedgerMetrics;
  if (!metrics) return;
  const breakdown = audit.historyCompletenessBreakdown ??
    explainHistoryCompleteness(metrics);
  const persistedCoverage = await loadPersistedCoverageSnapshot(wallet);
  const mergedCoverage = mergeMonotonicCoverageFields(persistedCoverage, {
    extendsBeforeApiBoundary: audit.extendsBeforeApiBoundary,
    eventsBeforeApiBoundary:
      audit.eventsBeforeApiBoundaryEffective ??
      audit.coverage.eventsBeforeApiBoundary,
    indexedOldestTimestamp: audit.coverage.indexedOldestTimestamp,
    lastIndexedBlock: audit.throughBlock ?? 0,
    lastReconstructedBlock: audit.throughBlock ?? 0,
  });
  const db = getDb();
  const walletAddress = normalizeWalletAddress(wallet);
  await db
    .insert(walletHistoryCoverage)
    .values({
      walletAddress,
      chainId: "137",
      provider: audit.providerId,
      fromBlock: audit.scanFromBlock ?? 0,
      lastIndexedBlock: mergedCoverage.lastIndexedBlock,
      lastReconstructedBlock: mergedCoverage.lastReconstructedBlock,
      apiOldestTimestamp: audit.coverage.apiOldestTimestamp,
      indexedOldestTimestamp: mergedCoverage.indexedOldestTimestamp,
      extendsBeforeApiBoundary: mergedCoverage.extendsBeforeApiBoundary,
      eventsBeforeApiBoundary: mergedCoverage.eventsBeforeApiBoundary,
      eventHistoryComplete: breakdown.eventHistoryComplete,
      identityComplete: breakdown.identityComplete,
      resolutionComplete: breakdown.resolutionComplete,
      historyComplete: metrics.historyComplete,
      historyValidity: metrics.historyValidity,
      timestampCoveragePct: audit.blockTimestampStats?.timestampCoveragePct ?? null,
      timestampMissingBlocks:
        audit.blockTimestampStats?.timestampMissingBlocks ?? null,
      gammaResolutionIncomplete: breakdown.gammaResolutionIncomplete,
      mergeSplitUnresolved: breakdown.mergeSplitUnresolved,
      metricVersion: WALLET_METRIC_VERSION,
    })
    .onConflictDoUpdate({
      target: walletHistoryCoverage.walletAddress,
      set: {
        provider: audit.providerId,
        lastIndexedBlock: mergedCoverage.lastIndexedBlock,
        lastReconstructedBlock: mergedCoverage.lastReconstructedBlock,
        apiOldestTimestamp: audit.coverage.apiOldestTimestamp,
        indexedOldestTimestamp: mergedCoverage.indexedOldestTimestamp,
        extendsBeforeApiBoundary: mergedCoverage.extendsBeforeApiBoundary,
        eventsBeforeApiBoundary: mergedCoverage.eventsBeforeApiBoundary,
        eventHistoryComplete: breakdown.eventHistoryComplete,
        identityComplete: breakdown.identityComplete,
        resolutionComplete: breakdown.resolutionComplete,
        historyComplete: metrics.historyComplete,
        historyValidity: metrics.historyValidity,
        timestampCoveragePct: audit.blockTimestampStats?.timestampCoveragePct ?? null,
        timestampMissingBlocks:
          audit.blockTimestampStats?.timestampMissingBlocks ?? null,
        gammaResolutionIncomplete: breakdown.gammaResolutionIncomplete,
        mergeSplitUnresolved: breakdown.mergeSplitUnresolved,
        metricVersion: WALLET_METRIC_VERSION,
        updatedAt: new Date(),
      },
    });
}

export async function repairAuthoritativeBaseline(
  wallet: string,
  authoritativeEvents: WalletLedgerEvent[],
  options: { abortSignal?: AbortSignal } = {}
): Promise<{
  authoritativePersistDiagnostics: AuthoritativePersistDiagnostics;
  logIndexCompleteness: LogIndexCompletenessReport;
  metadataEnrichment: MetadataEnrichmentStats;
  eventWriteStats: Awaited<ReturnType<typeof upsertWalletLedgerEvents>>;
}> {
  const chainAuthoritative = filterChainAuthoritativeEvents(authoritativeEvents);
  const persistedEventsBefore = await countWalletLedgerEvents(wallet);
  const metadataBefore = await countPersistedEventMetadataCoverage(wallet);
  const persistedDedupeKeys = await loadPersistedAuthoritativeDedupeKeys(wallet);
  const lastIndexedBlock = await loadLastIndexedBlock(wallet);
  const assessment = assessAuthoritativeBaselineCompleteness({
    authoritativeEvents: chainAuthoritative,
    persistedDedupeKeys,
    persistedEventsBefore,
    lastIndexedBlock,
  });
  const mode = resolveAuthoritativePersistenceMode(assessment);
  const candidateEvents = selectAuthoritativePersistenceCandidates({
    mode,
    authoritativeEvents: chainAuthoritative,
    deltaEvents: [],
    persistedDedupeKeys,
  });
  const eventWriteStats = await upsertWalletLedgerEvents(wallet, candidateEvents, {
    abortSignal: options.abortSignal,
  });
  const metadataEnrichment = await enrichPersistedLedgerEventMetadata(
    wallet,
    chainAuthoritative,
    { abortSignal: options.abortSignal }
  );
  await patchPersistedEventTimestamps(wallet, chainAuthoritative);
  const persistedEventsAfter = await countWalletLedgerEvents(wallet);
  const metadataAfter = await countPersistedEventMetadataCoverage(wallet);
  const persistedDedupeKeysAfter = await loadPersistedAuthoritativeDedupeKeys(wallet);
  const authoritativeEventsMissingAfter = countMissingAuthoritativeEvents(
    chainAuthoritative,
    persistedDedupeKeysAfter
  );
  const persistableMissingAfter = countMissingPersistableAuthoritativeEvents(
    chainAuthoritative,
    persistedDedupeKeysAfter
  );
  const authoritativePersistDiagnostics = buildAuthoritativePersistDiagnostics({
    mode,
    assessmentBefore: assessment,
    authoritativeEventsInserted: eventWriteStats.inserted,
    persistedEventsAfter,
    authoritativeEventsMissingAfter,
    persistableMissingAfter,
    authoritativeEventIdentityHash: hashAuthoritativeEventIdentities(chainAuthoritative),
    logIndexBackfills: metadataEnrichment.logIndexBackfills,
    timestampBackfills: metadataEnrichment.timestampBackfills,
    metadataConflicts: metadataEnrichment.metadataConflicts,
    selectionReason: assessment.selectionReason,
  });
  const logIndexCompleteness = buildLogIndexCompletenessReport({
    authoritativeEvents: chainAuthoritative,
    persistedWithLogIndexBefore: metadataBefore.withLogIndex,
    persistedWithLogIndexAfter: metadataAfter.withLogIndex,
    persistedMissingLogIndexAfter: metadataAfter.missingLogIndex,
    unmatchedLegacyRows: Math.max(
      0,
      metadataAfter.total - chainAuthoritative.length
    ),
    logIndexBackfills: metadataEnrichment.logIndexBackfills,
  });
  return {
    authoritativePersistDiagnostics,
    logIndexCompleteness,
    metadataEnrichment,
    eventWriteStats,
  };
}

export interface PersistIndexedWalletAuditOptions {
  abortSignal?: AbortSignal;
  /** When false (default), only Phase 1 authoritative writes run. */
  commitDerivedState?: boolean;
}

export interface AuthoritativePhaseResult {
  auditIndexedEvents: number;
  candidateEventsPresentedToPersistence: number;
  eventsUpserted: number;
  eventsSkippedExisting: number;
  eventWriteStats: Awaited<ReturnType<typeof upsertWalletLedgerEvents>>;
  metadataEnrichment: MetadataEnrichmentStats;
  authoritativePersistDiagnostics: AuthoritativePersistDiagnostics;
  logIndexCompleteness: LogIndexCompletenessReport;
}

export interface DerivedPhaseResult {
  positionsPersisted: number;
  positionsWriteMs: number;
  lifecycleStats: AtomicLifecycleReplaceStats;
  metricsWriteMs: number;
  coverageWriteMs: number;
}

export async function markDerivedStateCommitted(
  wallet: string
): Promise<void> {
  if (!walletHistoryDbEnabled()) return;
  const db = getDb();
  const walletAddress = normalizeWalletAddress(wallet);
  const [existing] = await db
    .select({
      historyIncompleteReasons: walletHistoricalMetrics.historyIncompleteReasons,
    })
    .from(walletHistoricalMetrics)
    .where(
      and(
        eq(walletHistoricalMetrics.walletAddress, walletAddress),
        eq(walletHistoricalMetrics.metricVersion, WALLET_METRIC_VERSION)
      )
    )
    .limit(1);
  const strip = new Set([
    "derived_state_uncommitted",
    "exact_replay_failed",
    "baseline_incomplete",
    "repair_run_invalidates_prior_failed_hydration",
  ]);
  const reasons = (existing?.historyIncompleteReasons ?? []).filter(
    (reason) => !strip.has(reason) && !reason.startsWith("baseline_incomplete")
  );
  await db
    .update(walletHistoricalMetrics)
    .set({
      historyIncompleteReasons: reasons,
      credibilityReasons: reasons,
      calculatedAt: new Date(),
    })
    .where(
      and(
        eq(walletHistoricalMetrics.walletAddress, walletAddress),
        eq(walletHistoricalMetrics.metricVersion, WALLET_METRIC_VERSION)
      )
    );
}

export async function markDerivedStateUncommitted(
  wallet: string,
  reason: string
): Promise<void> {
  if (!walletHistoryDbEnabled()) return;
  const db = getDb();
  const walletAddress = normalizeWalletAddress(wallet);
  const [existing] = await db
    .select({
      historyIncompleteReasons: walletHistoricalMetrics.historyIncompleteReasons,
    })
    .from(walletHistoricalMetrics)
    .where(
      and(
        eq(walletHistoricalMetrics.walletAddress, walletAddress),
        eq(walletHistoricalMetrics.metricVersion, WALLET_METRIC_VERSION)
      )
    )
    .limit(1);
  const reasons = new Set(existing?.historyIncompleteReasons ?? []);
  reasons.add("derived_state_uncommitted");
  reasons.add(reason);
  await db
    .update(walletHistoricalMetrics)
    .set({
      credibilityMetricsValid: false,
      credibilityDecision: false,
      historyComplete: false,
      historyValidity: "incomplete",
      historyIncompleteReasons: [...reasons],
      credibilityReasons: [...reasons],
      calculatedAt: new Date(),
    })
    .where(
      and(
        eq(walletHistoricalMetrics.walletAddress, walletAddress),
        eq(walletHistoricalMetrics.metricVersion, WALLET_METRIC_VERSION)
      )
    );
  await db
    .update(policyAProductionWalletHydration)
    .set({
      status: "failed",
      lastError: reason,
      updatedAt: new Date(),
    })
    .where(eq(policyAProductionWalletHydration.walletAddress, walletAddress));
  await db
    .update(walletHistoryCoverage)
    .set({
      historyComplete: false,
      historyValidity: "incomplete",
      updatedAt: new Date(),
    })
    .where(eq(walletHistoryCoverage.walletAddress, walletAddress));
}

export async function persistAuthoritativePhase(
  audit: IndexedAuditWalletResult,
  options: { abortSignal?: AbortSignal } = {}
): Promise<AuthoritativePhaseResult> {
  const deltaEvents = audit.indexedEvents ?? [];
  const authoritativeEvents = filterChainAuthoritativeEvents(
    audit.authoritativeIndexedEvents ?? deltaEvents
  );
  const persistedEventsBefore = await countWalletLedgerEvents(audit.wallet);
  const metadataBefore = await countPersistedEventMetadataCoverage(audit.wallet);
  const persistedDedupeKeys = await withDbCircuit(
    "loadPersistedAuthoritativeDedupeKeys",
    () =>
      withDbQueryTimeout("loadPersistedAuthoritativeDedupeKeys", () =>
        loadPersistedAuthoritativeDedupeKeys(audit.wallet)
      )
  );
  const lastIndexedBlock = await withDbCircuit("loadLastIndexedBlock", () =>
    withDbQueryTimeout("loadLastIndexedBlock", () =>
      loadLastIndexedBlock(audit.wallet)
    )
  );
  const assessment = assessAuthoritativeBaselineCompleteness({
    authoritativeEvents,
    persistedDedupeKeys,
    persistedEventsBefore,
    lastIndexedBlock,
  });
  const mode = resolveAuthoritativePersistenceMode(assessment);
  const candidateEvents = selectAuthoritativePersistenceCandidates({
    mode,
    authoritativeEvents,
    deltaEvents,
    persistedDedupeKeys,
  });
  console.error(
    `[event-persist] wallet=${audit.wallet} mode=${mode} authoritative=${authoritativeEvents.length} persistable=${assessment.persistableAuthoritativeCount} classD=${assessment.unresolvedClassDCount} delta=${deltaEvents.length} candidates=${candidateEvents.length} persistedBefore=${persistedEventsBefore} persistableMissingBefore=${assessment.persistableMissingBefore} lastIndexedBlock=${lastIndexedBlock ?? "none"} throughBlock=${audit.throughBlock ?? "none"} reason=${assessment.selectionReason}`
  );
  const eventWriteStats = await upsertWalletLedgerEvents(
    audit.wallet,
    candidateEvents,
    { abortSignal: options.abortSignal }
  );
  const metadataEnrichment = await enrichPersistedLedgerEventMetadata(
    audit.wallet,
    authoritativeEvents,
    { abortSignal: options.abortSignal }
  );
  if (
    metadataEnrichment.logIndexBackfills > 0 ||
    metadataEnrichment.timestampBackfills > 0 ||
    metadataEnrichment.blockNumberBackfills > 0 ||
    metadataEnrichment.metadataConflicts > 0
  ) {
    console.error(
      `[event-persist] wallet=${audit.wallet} metadataEnrichment matched=${metadataEnrichment.existingRowsMatched} logIndexBackfills=${metadataEnrichment.logIndexBackfills} timestampBackfills=${metadataEnrichment.timestampBackfills} blockNumberBackfills=${metadataEnrichment.blockNumberBackfills} conflicts=${metadataEnrichment.metadataConflicts} unchanged=${metadataEnrichment.rowsUnchanged}`
    );
  }
  const timestampPatches = await patchPersistedEventTimestamps(
    audit.wallet,
    authoritativeEvents
  );
  if (timestampPatches > 0) {
    console.error(
      `[event-persist] wallet=${audit.wallet} timestampPatches=${timestampPatches}`
    );
  }
  const persistedEventsAfter = await countWalletLedgerEvents(audit.wallet);
  const metadataAfter = await countPersistedEventMetadataCoverage(audit.wallet);
  const persistedDedupeKeysAfter = await withDbCircuit(
    "loadPersistedAuthoritativeDedupeKeysAfter",
    () =>
      withDbQueryTimeout("loadPersistedAuthoritativeDedupeKeysAfter", () =>
        loadPersistedAuthoritativeDedupeKeys(audit.wallet)
      )
  );
  const authoritativeEventsMissingAfter = countMissingAuthoritativeEvents(
    authoritativeEvents,
    persistedDedupeKeysAfter
  );
  const persistableMissingAfter = countMissingPersistableAuthoritativeEvents(
    authoritativeEvents,
    persistedDedupeKeysAfter
  );
  const authoritativePersistDiagnostics = buildAuthoritativePersistDiagnostics({
    mode,
    assessmentBefore: assessment,
    authoritativeEventsInserted: eventWriteStats.inserted,
    persistedEventsAfter,
    authoritativeEventsMissingAfter,
    persistableMissingAfter,
    authoritativeEventIdentityHash:
      hashAuthoritativeEventIdentities(authoritativeEvents),
    logIndexBackfills: metadataEnrichment.logIndexBackfills,
    timestampBackfills: metadataEnrichment.timestampBackfills,
    metadataConflicts: metadataEnrichment.metadataConflicts,
    selectionReason: assessment.selectionReason,
  });
  const logIndexCompleteness = buildLogIndexCompletenessReport({
    authoritativeEvents,
    persistedWithLogIndexBefore: metadataBefore.withLogIndex,
    persistedWithLogIndexAfter: metadataAfter.withLogIndex,
    persistedMissingLogIndexAfter: metadataAfter.missingLogIndex,
    unmatchedLegacyRows: Math.max(
      0,
      metadataAfter.total - authoritativeEvents.length
    ),
    logIndexBackfills: metadataEnrichment.logIndexBackfills,
  });
  console.error(
    `[event-persist] wallet=${audit.wallet} baselineComplete=${authoritativePersistDiagnostics.baselineComplete} inserted=${authoritativePersistDiagnostics.authoritativeEventsInserted} backfilled=${eventWriteStats.backfilled} persistedAfter=${persistedEventsAfter} persistableMissingAfter=${persistableMissingAfter} classD=${authoritativePersistDiagnostics.unresolvedClassDCount}`
  );
  return {
    auditIndexedEvents: deltaEvents.length,
    candidateEventsPresentedToPersistence: eventWriteStats.candidateEvents,
    eventsUpserted: eventWriteStats.inserted,
    eventsSkippedExisting: eventWriteStats.skippedExisting,
    eventWriteStats,
    metadataEnrichment,
    authoritativePersistDiagnostics,
    logIndexCompleteness,
  };
}

export async function persistDerivedPhase(
  audit: IndexedAuditWalletResult,
  options: { abortSignal?: AbortSignal } = {}
): Promise<DerivedPhaseResult> {
  const authoritativeEvents = filterChainAuthoritativeEvents(
    audit.authoritativeIndexedEvents ?? audit.indexedEvents ?? []
  );
  const positions = audit.indexedLifecyclePositions ?? [];
  const lifecycleStats = await atomicReplaceCurrentVersionWalletLifecycles(
    audit.wallet,
    positions,
    { abortSignal: options.abortSignal }
  );
  console.error(
    `[lifecycle-persist] wallet=${audit.wallet} lifecycleMode=${lifecycleStats.lifecycleMode} ` +
      `before=${lifecycleStats.lifecycleRowsBefore} upserted=${lifecycleStats.lifecycleRowsUpserted} ` +
      `staleDeleted=${lifecycleStats.staleLifecycleRowsDeleted} after=${lifecycleStats.lifecycleRowsAfter} ` +
      `replayCount=${lifecycleStats.replayLifecycleEpisodeCount} parity=${lifecycleStats.lifecycleParity} ` +
      `writeMs=${lifecycleStats.lifecycleWriteMs}`
  );
  if (!lifecycleStats.lifecycleParity) {
    throw new Error(
      `lifecycle_parity_failed wallet=${audit.wallet} after=${lifecycleStats.lifecycleRowsAfter} ` +
        `expected=${lifecycleStats.replayLifecycleEpisodeCount} ` +
        `persistedOnly=${lifecycleStats.lifecycleParityAudit.persistedKeysOnly.length} ` +
        `replayOnly=${lifecycleStats.lifecycleParityAudit.replayKeysOnly.length}`
    );
  }
  assertPersistenceNotAborted(options.abortSignal, "metrics-persist");
  const metricsStarted = Date.now();
  await withDbCircuit("upsertWalletHistoricalMetrics", () =>
    withDbQueryTimeout("upsertWalletHistoricalMetrics", () =>
      upsertWalletHistoricalMetrics(audit.wallet, audit)
    )
  );
  const metricsWriteMs = Date.now() - metricsStarted;
  assertPersistenceNotAborted(options.abortSignal, "coverage-persist");
  const coverageStarted = Date.now();
  await withDbCircuit("upsertWalletHistoryCoverage", () =>
    withDbQueryTimeout("upsertWalletHistoryCoverage", () =>
      upsertWalletHistoryCoverage(audit.wallet, audit)
    )
  );
  const coverageWriteMs = Date.now() - coverageStarted;
  return {
    positionsPersisted:
      lifecycleStats.lifecyclesInserted + lifecycleStats.lifecyclesUpdated,
    positionsWriteMs: lifecycleStats.lifecycleWriteMs,
    lifecycleStats,
    metricsWriteMs,
    coverageWriteMs,
  };
}

export function shouldCommitDerivedStateAfterBaseline(
  baselineComplete: boolean,
  commitDerivedState?: boolean
): boolean {
  return baselineComplete && commitDerivedState === true;
}

export async function persistIndexedWalletAudit(
  audit: IndexedAuditWalletResult,
  options: PersistIndexedWalletAuditOptions = {}
): Promise<
  AuthoritativePhaseResult &
    DerivedPhaseResult & { derivedStateCommitted: boolean }
> {
  const phase1 = await persistAuthoritativePhase(audit, options);
  if (!phase1.authoritativePersistDiagnostics.baselineComplete) {
    await markDerivedStateUncommitted(
      audit.wallet,
      `baseline_incomplete persistableMissingAfter=${phase1.authoritativePersistDiagnostics.persistableMissingAfter}`
    );
    return {
      ...phase1,
      positionsPersisted: 0,
      positionsWriteMs: 0,
      lifecycleStats: emptyAtomicLifecycleReplaceStats(),
      metricsWriteMs: 0,
      coverageWriteMs: 0,
      derivedStateCommitted: false,
    };
  }
  if (!shouldCommitDerivedStateAfterBaseline(true, options.commitDerivedState)) {
    return {
      ...phase1,
      positionsPersisted: 0,
      positionsWriteMs: 0,
      lifecycleStats: emptyAtomicLifecycleReplaceStats(),
      metricsWriteMs: 0,
      coverageWriteMs: 0,
      derivedStateCommitted: false,
    };
  }
  const phase2 = await persistDerivedPhase(audit, options);
  return {
    ...phase1,
    ...phase2,
    derivedStateCommitted: true,
  };
}

export async function loadPersistedWalletEvents(
  wallet: string
): Promise<WalletLedgerEvent[]> {
  const db = getDb();
  const { events } = await loadPersistedWalletEventsPaginated(
    db,
    normalizeWalletAddress(wallet)
  );
  return events;
}

export async function getWalletHistoryIntegrityReport(): Promise<{
  walletLedgerEvents: number;
  duplicateDedupeKeys: number;
  walletPositionLifecycles: number;
  walletHistoricalMetrics: number;
  walletHistoryCoverage: number;
}> {
  const db = getDb();
  const [events, dups, positions, metrics, coverage] = await Promise.all([
    db.select({ count: sql<number>`count(*)::int` }).from(walletLedgerEvents),
    countDuplicateDedupeKeys(),
    db.select({ count: sql<number>`count(*)::int` }).from(walletPositionLifecycles),
    db.select({ count: sql<number>`count(*)::int` }).from(walletHistoricalMetrics),
    db.select({ count: sql<number>`count(*)::int` }).from(walletHistoryCoverage),
  ]);
  return {
    walletLedgerEvents: events[0]?.count ?? 0,
    duplicateDedupeKeys: dups,
    walletPositionLifecycles: positions[0]?.count ?? 0,
    walletHistoricalMetrics: metrics[0]?.count ?? 0,
    walletHistoryCoverage: coverage[0]?.count ?? 0,
  };
}
