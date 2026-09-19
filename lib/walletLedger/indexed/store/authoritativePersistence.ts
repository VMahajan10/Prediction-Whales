import {
  assignChainEventDedupeKey,
  authoritativeEventMergeKey,
  classifyChainEventIdentity,
  hashCanonicalAuthoritativeIdentities,
} from "@/lib/walletLedger/canonicalChainIdentity";
import { hasFullCanonicalChainOrder } from "@/lib/walletLedger/eventOrder";
import {
  type AuthoritativeCoverageFingerprint,
  assessBaselineCompletenessAgainstFingerprint,
} from "@/lib/walletLedger/indexed/store/authoritativeCoverageFingerprint";
import type { WalletLedgerEvent } from "@/lib/walletLedger/types";

export type AuthoritativePersistenceMode = "baseline_repair" | "incremental";

export interface AuthoritativeBaselineAssessment {
  authoritativeEventsInAudit: number;
  persistableAuthoritativeCount: number;
  unresolvedClassDCount: number;
  persistedEventsBefore: number;
  authoritativeEventsMatched: number;
  authoritativeEventsMissingBefore: number;
  persistableMissingBefore: number;
  baselineComplete: boolean;
  coverageFingerprint?: AuthoritativeCoverageFingerprint;
  fingerprintMatch?: boolean;
  /** @deprecated lastIndexedBlock is not proof of baseline completeness. */
  lastIndexedBlock: number | null;
  selectionReason: string;
}

export interface AuthoritativePersistDiagnostics {
  mode: AuthoritativePersistenceMode;
  authoritativeEventsInAudit: number;
  persistableAuthoritativeCount: number;
  unresolvedClassDCount: number;
  persistedEventsBefore: number;
  authoritativeEventsMatched: number;
  authoritativeEventsMissingBefore: number;
  persistableMissingBefore: number;
  authoritativeEventsInserted: number;
  persistedEventsAfter: number;
  authoritativeEventsMissingAfter: number;
  persistableMissingAfter: number;
  logIndexBackfills: number;
  timestampBackfills: number;
  metadataConflicts: number;
  baselineComplete: boolean;
  authoritativeEventIdentityHash: string;
  selectionReason: string;
}

export type LogIndexExpectationClass =
  | "chain_log_expected"
  | "non_log_synthetic"
  | "unmatched_legacy";

export interface LogIndexCompletenessReport {
  authoritativeWithLogIndex: number;
  authoritativeExpectingLogIndex: number;
  authoritativeMissingLogIndex: number;
  persistedWithLogIndexBefore: number;
  persistedWithLogIndexAfter: number;
  logIndexBackfills: number;
  persistedMissingLogIndexAfter: number;
  unmatchedLegacyRows: number;
  rowsByClass: Record<LogIndexExpectationClass, number>;
}

export function isChainAuthoritativeEvent(event: WalletLedgerEvent): boolean {
  return event.source === "polygon";
}

export function filterChainAuthoritativeEvents(
  events: WalletLedgerEvent[]
): WalletLedgerEvent[] {
  const byKey = new Map<string, WalletLedgerEvent>();
  for (const event of events) {
    if (!isChainAuthoritativeEvent(event)) continue;
    const mergeKey = authoritativeEventMergeKey(
      assignChainEventDedupeKey(event)
    );
    if (!byKey.has(mergeKey)) {
      byKey.set(mergeKey, { ...event, dedupeKey: mergeKey });
    }
  }
  return [...byKey.values()];
}

/** Class-D unresolved chain logs are diagnostic-only — excluded from baseline denominator. */
export function isPersistableAuthoritativeEvent(event: WalletLedgerEvent): boolean {
  if (!isChainAuthoritativeEvent(event)) return false;
  return classifyChainEventIdentity(event) !== "unresolved_chain_log";
}

export function filterPersistableAuthoritativeEvents(
  events: WalletLedgerEvent[]
): WalletLedgerEvent[] {
  return filterChainAuthoritativeEvents(events).filter(
    isPersistableAuthoritativeEvent
  );
}

export function summarizePersistableAuthoritativeEvents(
  events: WalletLedgerEvent[]
): {
  authoritativeTotal: number;
  persistableTotal: number;
  unresolvedClassDTotal: number;
} {
  const authoritative = filterChainAuthoritativeEvents(events);
  const persistable = filterPersistableAuthoritativeEvents(events);
  return {
    authoritativeTotal: authoritative.length,
    persistableTotal: persistable.length,
    unresolvedClassDTotal: authoritative.length - persistable.length,
  };
}

export function hashAuthoritativeEventIdentities(
  events: WalletLedgerEvent[]
): string {
  return hashCanonicalAuthoritativeIdentities(
    filterChainAuthoritativeEvents(events)
  );
}

export function classifyLogIndexExpectation(
  event: WalletLedgerEvent
): LogIndexExpectationClass {
  if (!isChainAuthoritativeEvent(event)) {
    return "non_log_synthetic";
  }
  if ((event.blockNumber ?? 0) > 0) {
    return "chain_log_expected";
  }
  return "non_log_synthetic";
}

export function buildLogIndexCompletenessReport(input: {
  authoritativeEvents: WalletLedgerEvent[];
  persistedWithLogIndexBefore: number;
  persistedWithLogIndexAfter: number;
  persistedMissingLogIndexAfter: number;
  unmatchedLegacyRows: number;
  logIndexBackfills: number;
}): LogIndexCompletenessReport {
  const authoritative = filterChainAuthoritativeEvents(input.authoritativeEvents);
  let authoritativeWithLogIndex = 0;
  let authoritativeExpectingLogIndex = 0;
  let authoritativeMissingLogIndex = 0;
  const rowsByClass: Record<LogIndexExpectationClass, number> = {
    chain_log_expected: 0,
    non_log_synthetic: 0,
    unmatched_legacy: input.unmatchedLegacyRows,
  };

  for (const event of authoritative) {
    const className = classifyLogIndexExpectation(event);
    rowsByClass[className] += 1;
    if (className !== "chain_log_expected") continue;
    authoritativeExpectingLogIndex += 1;
    if (hasFullCanonicalChainOrder(event)) {
      authoritativeWithLogIndex += 1;
    } else {
      authoritativeMissingLogIndex += 1;
    }
  }

  return {
    authoritativeWithLogIndex,
    authoritativeExpectingLogIndex,
    authoritativeMissingLogIndex,
    persistedWithLogIndexBefore: input.persistedWithLogIndexBefore,
    persistedWithLogIndexAfter: input.persistedWithLogIndexAfter,
    logIndexBackfills: input.logIndexBackfills,
    persistedMissingLogIndexAfter: input.persistedMissingLogIndexAfter,
    unmatchedLegacyRows: input.unmatchedLegacyRows,
    rowsByClass,
  };
}

export async function loadPersistedAuthoritativeDedupeKeys(
  wallet: string
): Promise<Set<string>> {
  const { loadPersistedAuthoritativeDedupeKeysFromIndex } = await import(
    "@/lib/walletLedger/indexed/store/persistedAuthoritativeIndex"
  );
  return loadPersistedAuthoritativeDedupeKeysFromIndex(wallet);
}

export function assessAuthoritativeBaselineCompleteness(input: {
  authoritativeEvents: WalletLedgerEvent[];
  persistedDedupeKeys: Set<string>;
  persistedEventsBefore: number;
  lastIndexedBlock: number | null;
  coverageFingerprint?: AuthoritativeCoverageFingerprint;
  storedCoverageFingerprint?: AuthoritativeCoverageFingerprint | null;
}): AuthoritativeBaselineAssessment {
  const authoritative = filterChainAuthoritativeEvents(input.authoritativeEvents);
  const persistable = filterPersistableAuthoritativeEvents(input.authoritativeEvents);
  const unresolvedClassDCount = authoritative.length - persistable.length;
  let matched = 0;
  let persistableMatched = 0;
  for (const event of authoritative) {
    const mergeKey = authoritativeEventMergeKey(event);
    if (input.persistedDedupeKeys.has(mergeKey)) {
      matched += 1;
    }
  }
  for (const event of persistable) {
    const mergeKey = authoritativeEventMergeKey(event);
    if (input.persistedDedupeKeys.has(mergeKey)) {
      persistableMatched += 1;
    }
  }
  const missing = authoritative.length - matched;
  const persistableMissing = persistable.length - persistableMatched;
  const identitiesComplete = persistableMissing === 0;
  const fingerprintAssessment =
    input.coverageFingerprint == null
      ? null
      : assessBaselineCompletenessAgainstFingerprint({
          baselineComplete: identitiesComplete,
          storedFingerprint: input.storedCoverageFingerprint ?? null,
          currentFingerprint: input.coverageFingerprint,
        });
  const baselineComplete = fingerprintAssessment?.baselineComplete ?? identitiesComplete;
  const selectionReason = fingerprintAssessment?.reason ??
    (baselineComplete
      ? "all persistable authoritative chain identities present in wallet_ledger_events"
      : `missing ${persistableMissing} persistable authoritative identities (${unresolvedClassDCount} class-D excluded) despite lastIndexedBlock=${input.lastIndexedBlock ?? "none"}`);

  return {
    authoritativeEventsInAudit: authoritative.length,
    persistableAuthoritativeCount: persistable.length,
    unresolvedClassDCount,
    persistedEventsBefore: input.persistedEventsBefore,
    authoritativeEventsMatched: matched,
    authoritativeEventsMissingBefore: missing,
    persistableMissingBefore: persistableMissing,
    baselineComplete,
    coverageFingerprint: input.coverageFingerprint,
    fingerprintMatch: fingerprintAssessment?.fingerprintMatch,
    lastIndexedBlock: input.lastIndexedBlock,
    selectionReason,
  };
}

export function resolveAuthoritativePersistenceMode(
  assessment: AuthoritativeBaselineAssessment
): AuthoritativePersistenceMode {
  return assessment.baselineComplete ? "incremental" : "baseline_repair";
}

/**
 * Select events to insert.
 *
 * BASELINE_REPAIR: every authoritative chain identity missing from DB.
 * INCREMENTAL: only newly indexed delta identities missing from DB.
 *
 * Never uses lastIndexedBlock as proof that historical rows are complete.
 */
export function selectAuthoritativePersistenceCandidates(input: {
  mode: AuthoritativePersistenceMode;
  authoritativeEvents: WalletLedgerEvent[];
  deltaEvents: WalletLedgerEvent[];
  persistedDedupeKeys: Set<string>;
}): WalletLedgerEvent[] {
  const source =
    input.mode === "baseline_repair"
      ? input.authoritativeEvents
      : input.deltaEvents;
  const chain = filterPersistableAuthoritativeEvents(source);
  return chain.filter(
    (event) => !input.persistedDedupeKeys.has(authoritativeEventMergeKey(event))
  );
}

/**
 * Legacy block-cursor filter — caused sparse baselines when lastIndexedBlock was
 * high but historical wallet_ledger_events rows were incomplete.
 */
export function selectLegacyBlockIncrementalCandidates(
  allEvents: WalletLedgerEvent[],
  opts: { lastIndexedBlock: number | null; throughBlock: number | null }
): WalletLedgerEvent[] {
  const { lastIndexedBlock, throughBlock } = opts;
  if (lastIndexedBlock == null || throughBlock == null) {
    return allEvents;
  }
  if (throughBlock <= lastIndexedBlock) {
    return [];
  }
  return allEvents.filter((event) => (event.blockNumber ?? 0) > lastIndexedBlock);
}

export function countMissingAuthoritativeEvents(
  authoritativeEvents: WalletLedgerEvent[],
  persistedDedupeKeys: Set<string>
): number {
  const authoritative = filterChainAuthoritativeEvents(authoritativeEvents);
  let missing = 0;
  for (const event of authoritative) {
    if (!persistedDedupeKeys.has(authoritativeEventMergeKey(event))) {
      missing += 1;
    }
  }
  return missing;
}

export function countMissingPersistableAuthoritativeEvents(
  authoritativeEvents: WalletLedgerEvent[],
  persistedDedupeKeys: Set<string>
): number {
  const persistable = filterPersistableAuthoritativeEvents(authoritativeEvents);
  let missing = 0;
  for (const event of persistable) {
    if (!persistedDedupeKeys.has(authoritativeEventMergeKey(event))) {
      missing += 1;
    }
  }
  return missing;
}

export function buildAuthoritativePersistDiagnostics(input: {
  mode: AuthoritativePersistenceMode;
  assessmentBefore: AuthoritativeBaselineAssessment;
  authoritativeEventsInserted: number;
  persistedEventsAfter: number;
  authoritativeEventsMissingAfter: number;
  authoritativeEventIdentityHash: string;
  logIndexBackfills: number;
  timestampBackfills: number;
  metadataConflicts: number;
  selectionReason: string;
  persistableMissingAfter: number;
}): AuthoritativePersistDiagnostics {
  const baselineComplete = input.persistableMissingAfter === 0;
  return {
    mode: input.mode,
    authoritativeEventsInAudit: input.assessmentBefore.authoritativeEventsInAudit,
    persistableAuthoritativeCount:
      input.assessmentBefore.persistableAuthoritativeCount,
    unresolvedClassDCount: input.assessmentBefore.unresolvedClassDCount,
    persistedEventsBefore: input.assessmentBefore.persistedEventsBefore,
    authoritativeEventsMatched: input.assessmentBefore.authoritativeEventsMatched,
    authoritativeEventsMissingBefore:
      input.assessmentBefore.authoritativeEventsMissingBefore,
    persistableMissingBefore: input.assessmentBefore.persistableMissingBefore,
    authoritativeEventsInserted: input.authoritativeEventsInserted,
    persistedEventsAfter: input.persistedEventsAfter,
    authoritativeEventsMissingAfter: input.authoritativeEventsMissingAfter,
    persistableMissingAfter: input.persistableMissingAfter,
    logIndexBackfills: input.logIndexBackfills,
    timestampBackfills: input.timestampBackfills,
    metadataConflicts: input.metadataConflicts,
    baselineComplete,
    authoritativeEventIdentityHash: input.authoritativeEventIdentityHash,
    selectionReason: input.selectionReason,
  };
}
