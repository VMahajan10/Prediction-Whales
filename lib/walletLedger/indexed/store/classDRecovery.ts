import { and, eq, isNotNull } from "drizzle-orm";
import {
  isSamePhysicalChainLog,
  loadPersistedAuthoritativeIndex,
  mergeKeysForPersistedRow,
  physicalLogKey,
  type PersistedAuthoritativeIndex,
  type PersistedLedgerRowRef,
} from "@/lib/walletLedger/indexed/store/persistedAuthoritativeIndex";
import {
  parseCanonicalChainDedupeKey,
  type ReconcileOutcome,
} from "@/lib/walletLedger/indexed/store/canonicalEventReconciliation";
import { getDb } from "@/lib/crossmarket/store/db";
import { walletLedgerEvents } from "@/lib/crossmarket/store/schema";
import {
  buildCanonicalChainLogIdentity,
  classifyChainEventIdentity,
} from "@/lib/walletLedger/canonicalChainIdentity";
import {
  EXCHANGE_ADDRESSES,
  TOPIC_ORDER_FILLED_NEG_RISK,
  TOPIC_ORDER_FILLED_V1,
  TOPIC_PAYOUT_REDEMPTION,
  TOPIC_POSITION_SPLIT,
  TOPIC_POSITIONS_MERGE,
} from "@/lib/walletLedger/onchain/contracts";
import { decodeLog, orderFilledInvolvesWallet } from "@/lib/walletLedger/onchain/decode";
import { parsedEventsToLedgerEvents } from "@/lib/walletLedger/onchain/normalize";
import { parseBlockNumber, PolygonRpcClient } from "@/lib/walletLedger/onchain/rpc";
import type { ParsedOnChainEvent, RpcLog } from "@/lib/walletLedger/onchain/types";
import {
  auditReceiptCache,
  fetchTransactionReceiptCached,
  filterReceiptLogsForBlock,
  invalidateReceiptCache,
  isRetryableReceiptCacheStatus,
  isSuccessfulReceiptCacheEntry,
  readReceiptCacheEntry,
  receiptHasUsableLogs,
  type ReceiptCacheAuditSummary,
  type ReceiptFetchResult,
} from "@/lib/walletLedger/indexed/store/receiptCache";
import { EtherscanV2LogProvider } from "@/lib/walletLedger/indexed/providers/etherscan";
import {
  economicFieldsAgree,
  persistedRowToEvent,
  reconcileAuthoritativeEventBeforeInsert,
  type CanonicalReconciliationDiagnostics,
} from "@/lib/walletLedger/indexed/store/canonicalEventReconciliation";
import { filterChainAuthoritativeEvents, isChainAuthoritativeEvent } from "@/lib/walletLedger/indexed/store/authoritativePersistence";
import { loadPersistedWalletEvents } from "@/lib/walletLedger/indexed/store/persistWalletHistory";
import { assessUnresolvedChainOrder } from "@/lib/walletLedger/indexed/store/unresolvedChainOrder";
import { prepareAuthoritativeEventsForLifecycleMerge } from "@/lib/walletLedger/indexed/store/validationSnapshot";
import type { WalletLedgerEvent } from "@/lib/walletLedger/types";

const FLOAT_EPSILON = 1e-6;
const ORDER_FILLED_TOPICS = new Set([
  TOPIC_ORDER_FILLED_V1,
  TOPIC_ORDER_FILLED_NEG_RISK,
]);
const EXCHANGE_ADDRESS_SET = new Set<string>(EXCHANGE_ADDRESSES);

export type ClassDMatchOutcome =
  | "unique_match"
  | "unresolved_no_receipt_match"
  | "unresolved_ambiguous_receipt_match"
  | "provider_failure";

export interface ClassDRecoveryMatch {
  event: WalletLedgerEvent;
  outcome: ClassDMatchOutcome;
  recoveredLogIndex?: number;
  canonicalIdentity?: string;
  candidateLogIndexes?: number[];
}

export interface ClassDRecoveryReport {
  wallet: string;
  beforeClassD: number;
  uniqueTxHashes: number;
  receiptsFetched: number;
  receiptCacheHits: number;
  uniqueMatches: number;
  ambiguousMatches: number;
  noMatches: number;
  providerFailures: number;
  logIndexRecovered: number;
  canonicalized: number;
  remainingUnresolved: number;
  remainingUnresolvedInLifecycle: number;
  affectedPositionGroups: number;
  economicConflicts: number;
  ambiguousCollisions: number;
}

export interface ClassDResidualEventClassification {
  event: WalletLedgerEvent;
  outcome: ClassDMatchOutcome | "missing_tx_hash" | "receipt_unavailable";
  inLifecycle: boolean;
  providerFailure: boolean;
}

export interface NoReceiptMatchDiagnostic {
  dedupeKey: string;
  txHash: string | null;
  blockNumber: number | null;
  type: string;
  asset: string;
  shares: number | null;
  cashUsd: number | null;
  decodedCandidateCount: number;
  decodedTypes: string[];
  decodedAssets: string[];
  nearestCandidate?: {
    type: string;
    asset: string;
    shares: number | null;
    cashUsd: number | null;
    sharesDiff: number;
    cashDiff: number;
    typeMatch: boolean;
    assetMatch: boolean;
  };
  reason: string;
}

export interface AmbiguousMatchDiagnostic {
  dedupeKey: string;
  txHash: string | null;
  blockNumber: number | null;
  type: string;
  asset: string;
  shares: number | null;
  cashUsd: number | null;
  candidateLogIndexes: number[];
  candidateSummary: Array<{
    logIndex: number;
    type: string;
    asset: string;
    shares: number | null;
    cashUsd: number | null;
  }>;
}

export interface ClassDNormalizedCounts {
  wallet: string;
  totalClassDAuthoritativeRows: number;
  lifecycleRelevantClassDRows: number;
  uniqueClassDPhysicalEvents: number;
  uniqueTxHashes: number;
  uniqueMatchesFound: number;
  uniqueMatchesApplied: number;
  pendingUniqueMatchesNotApplied: number;
  unresolvedAmbiguousPhysicalEvents: number;
  unresolvedInfraPhysicalEvents: number;
  unresolvedNoMatchPhysicalEvents: number;
  remainingLifecycleRelevantUnresolved: number;
}

export type ReconciliationConflictCategory =
  | "A_same_wallet_same_log_equivalent_economics"
  | "B_same_wallet_economics_differ"
  | "C_legacy_duplicate_of_canonical"
  | "D_stale_dedupe_key_mapping"
  | "E_other";

export interface ReconciliationConflictDiagnosis {
  wallet: string;
  pendingUniqueMatches: number;
  categories: Record<ReconciliationConflictCategory, number>;
  samples: Array<{
    category: ReconciliationConflictCategory;
    dedupeKey: string;
    canonicalIdentity: string | null;
    authoritativeRowId: number | null;
    legacyRowId: number | null;
  }>;
}

export interface PendingUniqueMatchApplyReport {
  wallet: string;
  rootCause: string;
  beforeUnresolved: number;
  identifiedUniqueMatches: number;
  alreadyApplied: number;
  newlyApplied: number;
  canonicalAlreadySatisfied: number;
  legacyDuplicatesRetired: number;
  sameWalletEconomicConflicts: number;
  ambiguous: number;
  noMatch: number;
  applyFailures: number;
  applyFailureReasons: Record<string, number>;
  remainingPending: number;
  remainingLifecycleRelevantUnresolved: number;
  canonicalIdentityCountBefore: number;
  canonicalIdentityCountAfter: number;
}

export interface ClassDApplyResult {
  applied: boolean;
  conflict: boolean;
  outcome:
    | "recovery_applied"
    | "canonical_already_satisfied"
    | "legacy_duplicate_retired"
    | "economic_conflict"
    | "ambiguous_collision"
    | "row_not_found";
  authoritativeRowId?: number;
}

export interface InfraRetryReport {
  wallet: string;
  txsRetried: number;
  rpcRecovered: number;
  alternateRpcRecovered: number;
  fallbackRecovered: number;
  stillInfraFailed: number;
  stillInfraFailedTxHashes: string[];
  uniqueMatchesApplied: number;
  logIndexRecovered: number;
}

export interface AmbiguityTaxonomy {
  wallet: string;
  inspectedTxCount: number;
  categories: Record<string, number>;
  resolvedByDisambiguation: number;
  remainingAmbiguous: number;
}

export interface ClassDResidualTaxonomy {
  wallet: string;
  classDBeforeLifecycle: number;
  currentClassDTotal: number;
  currentClassDInLifecycle: number;
  matchPass: {
    uniqueMatch: number;
    noReceiptMatch: number;
    ambiguousMatch: number;
    missingTxHash: number;
  };
  infrastructure: {
    providerFailureEvents: number;
    providerFailureTxHashes: string[];
    receiptUnavailableEvents: number;
  };
  genuineUnresolved: {
    noReceiptMatch: number;
    ambiguousMatch: number;
    missingTxHash: number;
  };
  remaining: {
    lifecycleRelevantUnresolved: number;
    uniqueTxHashesAmongLifecycleUnresolved: number;
    affectedPositionGroups: number;
  };
  applyStats?: {
    canonicalized: number;
    economicConflicts: number;
  };
  noReceiptMatchSamples: NoReceiptMatchDiagnostic[];
  ambiguousMatchSamples: AmbiguousMatchDiagnostic[];
}

function economicallyEquivalent(
  left: WalletLedgerEvent,
  right: WalletLedgerEvent
): boolean {
  if (left.type !== right.type) return false;
  if (left.wallet.toLowerCase() !== right.wallet.toLowerCase()) return false;
  if ((left.asset ?? "") !== (right.asset ?? "")) return false;
  if ((left.txHash ?? "").toLowerCase() !== (right.txHash ?? "").toLowerCase()) {
    return false;
  }
  if ((left.blockNumber ?? 0) !== (right.blockNumber ?? 0)) return false;
  const sharesDiff = Math.abs((left.shares ?? 0) - (right.shares ?? 0));
  const cashDiff = Math.abs((left.cashUsd ?? 0) - (right.cashUsd ?? 0));
  return sharesDiff <= FLOAT_EPSILON && cashDiff <= FLOAT_EPSILON;
}

interface EnrichedClassDCandidate {
  ledgerEvent: WalletLedgerEvent;
  log: RpcLog;
  topic0: string;
  contractAddress: string;
  parsedKind: ParsedOnChainEvent["type"];
}

function parsedKindLabel(parsed: ParsedOnChainEvent): string {
  if (parsed.type === "unparsed") return parsed.reason ?? "unparsed";
  return parsed.type;
}

function receiptLogsToEnrichedCandidates(
  logs: RpcLog[],
  wallet: string,
  blockNumber: number
): EnrichedClassDCandidate[] {
  const results: EnrichedClassDCandidate[] = [];
  for (const log of logs) {
    const parsed = decodeLog(log);
    const { events } = parsedEventsToLedgerEvents(
      [parsed],
      wallet.toLowerCase(),
      new Map([[blockNumber, 0]])
    );
    for (const ledgerEvent of events) {
      results.push({
        ledgerEvent,
        log,
        topic0: log.topics[0]?.toLowerCase() ?? "",
        contractAddress: log.address.toLowerCase(),
        parsedKind: parsed.type,
      });
    }
  }
  return results;
}

function isExchangeOrderFill(candidate: EnrichedClassDCandidate): boolean {
  return (
    candidate.parsedKind === "order_filled" ||
    ORDER_FILLED_TOPICS.has(candidate.topic0)
  );
}

function classifyAmbiguityRootCause(
  event: WalletLedgerEvent,
  candidates: EnrichedClassDCandidate[]
): string {
  const equivalent = candidates.filter((candidate) =>
    economicallyEquivalent(event, candidate.ledgerEvent)
  );
  if (equivalent.length <= 1) return "not_ambiguous";
  const orderFills = equivalent.filter(isExchangeOrderFill);
  const erc1155 = equivalent.filter(
    (candidate) => candidate.parsedKind === "erc1155_transfer"
  );
  if (orderFills.length >= 1 && erc1155.length >= 1) {
    return "order_fill_vs_erc1155_duplicate";
  }
  if (orderFills.length > 1) return "multiple_order_fills_same_economics";
  if (erc1155.length > 1) return "multiple_erc1155_same_economics";
  const logIndexes = equivalent
    .map((candidate) => candidate.ledgerEvent.logIndex ?? -1)
    .sort((a, b) => a - b);
  if (
    logIndexes.length === 2 &&
    logIndexes[1]! - logIndexes[0]! === 2
  ) {
    return "adjacent_logindex_plus_two_identical_economics";
  }
  return "other_multiple_economic_matches";
}

export function disambiguateClassDCandidates(
  event: WalletLedgerEvent,
  candidates: EnrichedClassDCandidate[]
): EnrichedClassDCandidate | null {
  const equivalent = candidates.filter((candidate) =>
    economicallyEquivalent(event, candidate.ledgerEvent)
  );
  if (equivalent.length <= 1) return equivalent[0] ?? null;

  if (event.type === "BUY" || event.type === "SELL") {
    const orderFills = equivalent.filter(isExchangeOrderFill);
    if (orderFills.length === 1) return orderFills[0]!;
    if (orderFills.length > 1) {
      const wallet = event.wallet.toLowerCase();
      const roleMatches = orderFills.filter((candidate) => {
        const parsed = decodeLog(candidate.log);
        if (parsed.type !== "order_filled") return false;
        return orderFilledInvolvesWallet(parsed.event, wallet);
      });
      if (roleMatches.length === 1) return roleMatches[0]!;
    }
  }

  if (event.type === "REDEEM") {
    const redeems = equivalent.filter(
      (candidate) => candidate.topic0 === TOPIC_PAYOUT_REDEMPTION
    );
    if (redeems.length === 1) return redeems[0]!;
  }

  if (event.type === "SPLIT") {
    const splits = equivalent.filter(
      (candidate) => candidate.topic0 === TOPIC_POSITION_SPLIT
    );
    if (splits.length === 1) return splits[0]!;
  }

  if (event.type === "MERGE") {
    const merges = equivalent.filter(
      (candidate) => candidate.topic0 === TOPIC_POSITIONS_MERGE
    );
    if (merges.length === 1) return merges[0]!;
  }

  const exchangeOnly = equivalent.filter((candidate) =>
    EXCHANGE_ADDRESS_SET.has(candidate.contractAddress)
  );
  if (exchangeOnly.length === 1) return exchangeOnly[0]!;

  return null;
}

function receiptLogsToLedgerCandidates(
  logs: RpcLog[],
  wallet: string,
  blockNumber: number
): WalletLedgerEvent[] {
  const parsed = logs.map((log) => decodeLog(log));
  const { events } = parsedEventsToLedgerEvents(
    parsed,
    wallet.toLowerCase(),
    new Map([[blockNumber, 0]])
  );
  return events;
}

export function matchClassDEventToReceipt(input: {
  event: WalletLedgerEvent;
  receiptLogs: RpcLog[];
  decodedCandidates?: WalletLedgerEvent[];
  enrichedCandidates?: EnrichedClassDCandidate[];
}): ClassDRecoveryMatch {
  const { event } = input;
  if (classifyChainEventIdentity(event) !== "unresolved_chain_log") {
    return { event, outcome: "unresolved_no_receipt_match" };
  }
  const blockNumber = event.blockNumber ?? 0;
  const enriched =
    input.enrichedCandidates ??
    receiptLogsToEnrichedCandidates(
      input.receiptLogs,
      event.wallet,
      blockNumber
    );
  const candidates = enriched.map((candidate) => candidate.ledgerEvent);
  const equivalentLedger = candidates.filter((candidate) =>
    economicallyEquivalent(event, candidate)
  );

  if (equivalentLedger.length === 0) {
    const fallbackCandidates = input.decodedCandidates ??
      receiptLogsToLedgerCandidates(
        input.receiptLogs,
        event.wallet,
        blockNumber
      );
    const fallbackEquivalent = fallbackCandidates.filter((candidate) =>
      economicallyEquivalent(event, candidate)
    );
    if (fallbackEquivalent.length === 0) {
      return { event, outcome: "unresolved_no_receipt_match" };
    }
    if (fallbackEquivalent.length > 1) {
      return {
        event,
        outcome: "unresolved_ambiguous_receipt_match",
        candidateLogIndexes: fallbackEquivalent
          .map((candidate) => candidate.logIndex)
          .filter((value): value is number => value != null && value >= 0),
      };
    }
    const match = fallbackEquivalent[0]!;
    const logIndex = match.logIndex!;
    return {
      event,
      outcome: "unique_match",
      recoveredLogIndex: logIndex,
      canonicalIdentity: buildCanonicalChainLogIdentity({
        txHash: event.txHash!,
        logIndex,
      }),
    };
  }

  if (equivalentLedger.length > 1) {
    const disambiguated = disambiguateClassDCandidates(event, enriched);
    if (!disambiguated) {
      return {
        event,
        outcome: "unresolved_ambiguous_receipt_match",
        candidateLogIndexes: equivalentLedger
          .map((candidate) => candidate.logIndex)
          .filter((value): value is number => value != null && value >= 0),
      };
    }
    const logIndex = disambiguated.ledgerEvent.logIndex!;
    return {
      event,
      outcome: "unique_match",
      recoveredLogIndex: logIndex,
      canonicalIdentity: buildCanonicalChainLogIdentity({
        txHash: event.txHash!,
        logIndex,
      }),
    };
  }

  const match = equivalentLedger[0]!;
  const logIndex = match.logIndex!;
  return {
    event,
    outcome: "unique_match",
    recoveredLogIndex: logIndex,
    canonicalIdentity: buildCanonicalChainLogIdentity({
      txHash: event.txHash!,
      logIndex,
    }),
  };
}

function persistedRowRefFromDbRow(row: {
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
  source: string;
  walletAddress: string;
}): PersistedLedgerRowRef {
  return {
    id: row.id,
    dedupeKey: row.dedupeKey,
    canonicalIdentity: row.canonicalIdentity,
    txHash: row.txHash,
    logIndex: row.logIndex != null ? Number.parseInt(row.logIndex, 10) : null,
    blockNumber: row.blockNumber,
    eventType: row.eventType,
    assetId: row.assetId,
    shares: row.shares,
    cashUsd: row.cashUsd,
    source: row.source,
    walletAddress: row.walletAddress,
  };
}

function unregisterRowFromIndex(
  index: PersistedAuthoritativeIndex,
  row: PersistedLedgerRowRef
): void {
  index.byDedupeKey.delete(row.dedupeKey);
  if (row.canonicalIdentity?.trim()) {
    index.byCanonicalIdentity.delete(row.canonicalIdentity);
  }
  if (row.txHash && row.logIndex != null) {
    index.byPhysicalLog.delete(physicalLogKey(row.txHash, row.logIndex));
  }
  for (const key of mergeKeysForPersistedRow(row)) {
    index.mergeKeys.delete(key);
  }
}

async function retireLegacyClassDRow(
  wallet: string,
  row: PersistedLedgerRowRef,
  index: PersistedAuthoritativeIndex
): Promise<boolean> {
  const db = getDb();
  const walletAddress = wallet.toLowerCase();
  await db
    .delete(walletLedgerEvents)
    .where(
      and(
        eq(walletLedgerEvents.id, row.id),
        eq(walletLedgerEvents.walletAddress, walletAddress)
      )
    );
  unregisterRowFromIndex(index, row);
  return true;
}

export function classifyReconciliationConflict(input: {
  event: WalletLedgerEvent;
  recoveredLogIndex: number;
  canonicalIdentity: string;
  legacyRow: PersistedLedgerRowRef | null;
  reconcileOutcome: ReconcileOutcome;
  authoritativeRow: PersistedLedgerRowRef | null;
  recoveredEvent: WalletLedgerEvent;
}): ReconciliationConflictCategory {
  const { reconcileOutcome, authoritativeRow, legacyRow, recoveredEvent } = input;
  if (reconcileOutcome.kind === "economic_conflict") {
    return "B_same_wallet_economics_differ";
  }
  if (reconcileOutcome.kind === "ambiguous_collision") {
    if (legacyRow) {
      const parsed = parseCanonicalChainDedupeKey(legacyRow.dedupeKey);
      if (
        parsed &&
        legacyRow.txHash &&
        legacyRow.logIndex != null &&
        (legacyRow.txHash.toLowerCase() !== parsed.txHash.toLowerCase() ||
          legacyRow.logIndex !== parsed.logIndex)
      ) {
        return "D_stale_dedupe_key_mapping";
      }
    }
    return "E_other";
  }
  if (!authoritativeRow) return "E_other";
  if (
    legacyRow &&
    legacyRow.id !== authoritativeRow.id &&
    classifyChainEventIdentity(input.event) === "unresolved_chain_log"
  ) {
    return "C_legacy_duplicate_of_canonical";
  }
  if (
    isSamePhysicalChainLog(recoveredEvent, authoritativeRow) &&
    economicFieldsAgree(recoveredEvent, authoritativeRow)
  ) {
    return "A_same_wallet_same_log_equivalent_economics";
  }
  if (!economicFieldsAgree(recoveredEvent, authoritativeRow)) {
    return "B_same_wallet_economics_differ";
  }
  return "E_other";
}

export async function diagnoseReconciliationConflicts(
  wallet: string
): Promise<ReconciliationConflictDiagnosis> {
  const normalized = wallet.toLowerCase();
  const index = await loadPersistedAuthoritativeIndex(normalized);
  const categories: Record<ReconciliationConflictCategory, number> = {
    A_same_wallet_same_log_equivalent_economics: 0,
    B_same_wallet_economics_differ: 0,
    C_legacy_duplicate_of_canonical: 0,
    D_stale_dedupe_key_mapping: 0,
    E_other: 0,
  };
  const samples: ReconciliationConflictDiagnosis["samples"] = [];
  const classifications = await classifyClassDResidualEvents(normalized);
  const pending = classifications.filter((row) => row.outcome === "unique_match");

  const txHashes = [
    ...new Set(
      pending
        .map((row) => row.event.txHash?.toLowerCase())
        .filter((hash): hash is string => Boolean(hash))
    ),
  ];
  const receiptByTx = new Map<string, RpcLog[]>();
  const enrichedByTx = new Map<string, EnrichedClassDCandidate[]>();
  for (const txHash of txHashes) {
    const blockNumber =
      pending.find((row) => row.event.txHash?.toLowerCase() === txHash)?.event
        .blockNumber ?? 0;
    const fetched = await fetchReceiptLogsForTx({ txHash, blockNumber });
    if (!fetched.logs) continue;
    receiptByTx.set(txHash, fetched.logs);
    enrichedByTx.set(
      txHash,
      receiptLogsToEnrichedCandidates(fetched.logs, normalized, blockNumber)
    );
  }

  const db = getDb();
  for (const row of pending) {
    const event = row.event;
    const txHash = event.txHash?.toLowerCase();
    if (!txHash) continue;
    const logs = receiptByTx.get(txHash);
    if (!logs) continue;
    const match = matchClassDEventToReceipt({
      event,
      receiptLogs: logs,
      enrichedCandidates: enrichedByTx.get(txHash),
    });
    if (
      match.outcome !== "unique_match" ||
      match.recoveredLogIndex == null ||
      !match.canonicalIdentity
    ) {
      continue;
    }
    const recoveredEvent: WalletLedgerEvent = {
      ...event,
      logIndex: match.recoveredLogIndex,
      txHash: event.txHash,
      blockNumber: event.blockNumber,
    };
    const [legacyDbRow] = await db
      .select()
      .from(walletLedgerEvents)
      .where(
        and(
          eq(walletLedgerEvents.walletAddress, normalized),
          eq(walletLedgerEvents.dedupeKey, event.dedupeKey)
        )
      )
      .limit(1);
    const legacyRow = legacyDbRow
      ? persistedRowRefFromDbRow(legacyDbRow)
      : null;
    const authoritativeRow =
      index.byCanonicalIdentity.get(match.canonicalIdentity) ?? null;
    let reconcileOutcome: ReconcileOutcome = { kind: "insert" };
    if (authoritativeRow) {
      reconcileOutcome = economicFieldsAgree(recoveredEvent, authoritativeRow)
        ? { kind: "satisfied" }
        : {
            kind: "economic_conflict",
            dedupeKey: event.dedupeKey,
            rowId: authoritativeRow.id,
          };
    } else if (legacyRow) {
      const parsed = parseCanonicalChainDedupeKey(legacyRow.dedupeKey);
      if (
        parsed &&
        legacyRow.txHash &&
        legacyRow.logIndex != null &&
        (legacyRow.txHash.toLowerCase() !== parsed.txHash.toLowerCase() ||
          legacyRow.logIndex !== parsed.logIndex)
      ) {
        reconcileOutcome = {
          kind: "ambiguous_collision",
          dedupeKey: event.dedupeKey,
          rowId: legacyRow.id,
        };
      }
    }
    const category = classifyReconciliationConflict({
      event,
      recoveredLogIndex: match.recoveredLogIndex,
      canonicalIdentity: match.canonicalIdentity,
      legacyRow,
      reconcileOutcome,
      authoritativeRow,
      recoveredEvent,
    });
    categories[category] += 1;
    if (samples.length < 10) {
      samples.push({
        category,
        dedupeKey: event.dedupeKey,
        canonicalIdentity: match.canonicalIdentity,
        authoritativeRowId: authoritativeRow?.id ?? null,
        legacyRowId: legacyRow?.id ?? null,
      });
    }
  }

  return {
    wallet: normalized,
    pendingUniqueMatches: pending.length,
    categories,
    samples,
  };
}

async function applyRecoveredMetadata(input: {
  wallet: string;
  event: WalletLedgerEvent;
  recoveredLogIndex: number;
  canonicalIdentity: string;
  index: PersistedAuthoritativeIndex;
  diagnostics: CanonicalReconciliationDiagnostics;
}): Promise<ClassDApplyResult> {
  const db = getDb();
  const walletAddress = input.wallet.toLowerCase();
  const [row] = await db
    .select()
    .from(walletLedgerEvents)
    .where(
      and(
        eq(walletLedgerEvents.walletAddress, walletAddress),
        eq(walletLedgerEvents.dedupeKey, input.event.dedupeKey)
      )
    )
    .limit(1);
  const resolvedDbRow =
    row ??
    (await db
      .select()
      .from(walletLedgerEvents)
      .where(
        and(
          eq(walletLedgerEvents.walletAddress, walletAddress),
          eq(walletLedgerEvents.txHash, input.event.txHash?.toLowerCase() ?? ""),
          eq(walletLedgerEvents.blockNumber, input.event.blockNumber ?? 0),
          eq(walletLedgerEvents.eventType, input.event.type),
          eq(walletLedgerEvents.assetId, input.event.asset ?? "")
        )
      )
      .limit(1))[0];
  if (!resolvedDbRow) {
    return { applied: false, conflict: false, outcome: "row_not_found" };
  }
  const resolvedRow = persistedRowRefFromDbRow(resolvedDbRow);

  const recoveredEvent: WalletLedgerEvent = {
    ...input.event,
    logIndex: input.recoveredLogIndex,
    txHash: input.event.txHash,
    blockNumber: input.event.blockNumber,
  };

  const outcome = await reconcileAuthoritativeEventBeforeInsert(
    walletAddress,
    recoveredEvent,
    input.index,
    input.diagnostics
  );
  if (outcome.kind === "economic_conflict") {
    return {
      applied: false,
      conflict: true,
      outcome: "economic_conflict",
      authoritativeRowId: outcome.rowId,
    };
  }
  if (outcome.kind === "ambiguous_collision") {
    return {
      applied: false,
      conflict: true,
      outcome: "ambiguous_collision",
      authoritativeRowId: outcome.rowId,
    };
  }

  const existingByCanonical = input.index.byCanonicalIdentity.get(
    input.canonicalIdentity
  );
  if (existingByCanonical) {
    if (!economicFieldsAgree(recoveredEvent, existingByCanonical)) {
      return {
        applied: false,
        conflict: true,
        outcome: "economic_conflict",
        authoritativeRowId: existingByCanonical.id,
      };
    }
    if (existingByCanonical.id !== resolvedRow.id) {
      await retireLegacyClassDRow(walletAddress, resolvedRow, input.index);
      return {
        applied: true,
        conflict: false,
        outcome: "legacy_duplicate_retired",
        authoritativeRowId: existingByCanonical.id,
      };
    }
    return {
      applied: true,
      conflict: false,
      outcome: "canonical_already_satisfied",
      authoritativeRowId: existingByCanonical.id,
    };
  }

  await db
    .update(walletLedgerEvents)
    .set({
      logIndex: String(input.recoveredLogIndex),
      canonicalIdentity: input.canonicalIdentity,
      txHash: input.event.txHash?.toLowerCase() ?? resolvedDbRow.txHash,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(walletLedgerEvents.id, resolvedRow.id),
        eq(walletLedgerEvents.walletAddress, walletAddress)
      )
    );

  const updatedRow: PersistedLedgerRowRef = {
    ...resolvedRow,
    canonicalIdentity: input.canonicalIdentity,
    txHash: input.event.txHash?.toLowerCase() ?? resolvedRow.txHash,
    logIndex: input.recoveredLogIndex,
  };
  input.index.byCanonicalIdentity.set(input.canonicalIdentity, updatedRow);
  input.index.byDedupeKey.set(updatedRow.dedupeKey, updatedRow);
  input.index.byPhysicalLog.set(
    physicalLogKey(updatedRow.txHash!, updatedRow.logIndex!),
    updatedRow
  );
  for (const key of mergeKeysForPersistedRow(updatedRow)) {
    input.index.mergeKeys.add(key);
  }

  return { applied: true, conflict: false, outcome: "recovery_applied" };
}

function lifecycleUnresolvedKeys(events: WalletLedgerEvent[]): Set<string> {
  const lifecycleChain = prepareAuthoritativeEventsForLifecycleMerge(
    filterChainAuthoritativeEvents(events)
  );
  const keys = new Set<string>();
  for (const event of lifecycleChain) {
    if (
      isChainAuthoritativeEvent(event) &&
      classifyChainEventIdentity(event) === "unresolved_chain_log"
    ) {
      keys.add(event.dedupeKey);
    }
  }
  return keys;
}

function nearestDecodedCandidate(
  event: WalletLedgerEvent,
  candidates: WalletLedgerEvent[]
): NoReceiptMatchDiagnostic["nearestCandidate"] | undefined {
  if (candidates.length === 0) return undefined;
  let best: WalletLedgerEvent | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const sharesDiff = Math.abs((event.shares ?? 0) - (candidate.shares ?? 0));
    const cashDiff = Math.abs((event.cashUsd ?? 0) - (candidate.cashUsd ?? 0));
    const score = sharesDiff + cashDiff + (event.type !== candidate.type ? 1000 : 0);
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  if (!best) return undefined;
  return {
    type: best.type,
    asset: best.asset ?? "",
    shares: best.shares ?? null,
    cashUsd: best.cashUsd ?? null,
    sharesDiff: Math.abs((event.shares ?? 0) - (best.shares ?? 0)),
    cashDiff: Math.abs((event.cashUsd ?? 0) - (best.cashUsd ?? 0)),
    typeMatch: event.type === best.type,
    assetMatch: (event.asset ?? "") === (best.asset ?? ""),
  };
}

function diagnoseNoReceiptMatch(
  event: WalletLedgerEvent,
  decodedCandidates: WalletLedgerEvent[]
): NoReceiptMatchDiagnostic {
  const nearest = nearestDecodedCandidate(event, decodedCandidates);
  let reason = "no_economic_match_in_receipt";
  if (decodedCandidates.length === 0) {
    reason = "receipt_decoded_zero_wallet_events";
  } else if (nearest && !nearest.typeMatch) {
    reason = "type_mismatch";
  } else if (nearest && !nearest.assetMatch) {
    reason = "asset_mismatch";
  } else if (nearest && (nearest.sharesDiff > FLOAT_EPSILON || nearest.cashDiff > FLOAT_EPSILON)) {
    reason = "shares_or_cash_mismatch";
  }
  return {
    dedupeKey: event.dedupeKey,
    txHash: event.txHash ?? null,
    blockNumber: event.blockNumber ?? null,
    type: event.type,
    asset: event.asset ?? "",
    shares: event.shares ?? null,
    cashUsd: event.cashUsd ?? null,
    decodedCandidateCount: decodedCandidates.length,
    decodedTypes: [...new Set(decodedCandidates.map((c) => c.type))],
    decodedAssets: [...new Set(decodedCandidates.map((c) => c.asset ?? ""))].slice(
      0,
      5
    ),
    nearestCandidate: nearest,
    reason,
  };
}

export { auditReceiptCache, type ReceiptCacheAuditSummary };

async function countCanonicalIdentities(wallet: string): Promise<number> {
  const db = getDb();
  const rows = await db
    .select({ id: walletLedgerEvents.id })
    .from(walletLedgerEvents)
    .where(
      and(
        eq(walletLedgerEvents.walletAddress, wallet.toLowerCase()),
        isNotNull(walletLedgerEvents.canonicalIdentity)
      )
    );
  return rows.length;
}

async function fetchReceiptLogsForTx(input: {
  txHash: string;
  blockNumber: number;
  rpc?: PolygonRpcClient;
  etherscan?: EtherscanV2LogProvider;
  forceRefetch?: boolean;
}): Promise<{
  logs: RpcLog[] | null;
  providerFailure: boolean;
  fetchResult: ReceiptFetchResult;
}> {
  const result = await fetchTransactionReceiptCached({
    txHash: input.txHash,
    rpc: input.rpc,
    etherscan: input.etherscan,
    forceRefetch: input.forceRefetch,
  });
  if (result.providerFailure) {
    return { logs: null, providerFailure: true, fetchResult: result };
  }
  if (!receiptHasUsableLogs(result.receipt)) {
    return { logs: null, providerFailure: false, fetchResult: result };
  }
  return {
    logs: filterReceiptLogsForBlock(result.receipt!, input.blockNumber),
    providerFailure: false,
    fetchResult: result,
  };
}

export async function diagnosePendingUniqueMatchRootCause(
  wallet: string
): Promise<{ rootCause: string; evidence: Record<string, number | string> }> {
  const normalized = wallet.toLowerCase();
  const classifications = await classifyClassDResidualEvents(normalized);
  const pending = classifications.filter((row) => row.outcome === "unique_match");
  const pendingTxHashes = new Set(
    pending
      .map((row) => row.event.txHash?.toLowerCase())
      .filter((hash): hash is string => Boolean(hash))
  );

  let retryableCachedTx = 0;
  let legacyEmptyCachedTx = 0;
  let validCachedTx = 0;
  for (const txHash of pendingTxHashes) {
    const entry = readReceiptCacheEntry(txHash);
    if (!entry) continue;
    if (entry.status === "valid_receipt") validCachedTx += 1;
    if (isRetryableReceiptCacheStatus(entry.status)) retryableCachedTx += 1;
    if (entry.status === "empty_response") legacyEmptyCachedTx += 1;
  }

  if (retryableCachedTx > 0 || legacyEmptyCachedTx > 0) {
    return {
      rootCause:
        "receipt_cache_poisoning_transient_or_empty_failures_previously_cached_as_success",
      evidence: {
        pendingUniqueMatches: pending.length,
        pendingTxHashes: pendingTxHashes.size,
        retryableCachedTx,
        legacyEmptyCachedTx,
        validCachedTx,
      },
    };
  }

  if (pending.length > 0) {
    return {
      rootCause:
        "matcher_identified_unique_matches_but_apply_pass_not_run_or_partially_aborted",
      evidence: {
        pendingUniqueMatches: pending.length,
        pendingTxHashes: pendingTxHashes.size,
        validCachedTx,
      },
    };
  }

  return {
    rootCause: "none_pending",
    evidence: { pendingUniqueMatches: 0 },
  };
}

export async function applyPendingUniqueClassDMatches(
  wallet: string,
  options: { rpc?: PolygonRpcClient; etherscan?: EtherscanV2LogProvider } = {}
): Promise<PendingUniqueMatchApplyReport> {
  const normalized = wallet.toLowerCase();
  const diagnosis = await diagnosePendingUniqueMatchRootCause(normalized);
  const canonicalBefore = await countCanonicalIdentities(normalized);
  const eventsBefore = await loadPersistedWalletEvents(normalized);
  const beforeUnresolved = assessUnresolvedChainOrder(eventsBefore)
    .unresolvedChainEventsInLifecycle;
  const events = eventsBefore;
  const classDEvents = filterChainAuthoritativeEvents(events).filter(
    (event) => classifyChainEventIdentity(event) === "unresolved_chain_log"
  );

  const txHashes = [
    ...new Set(
      classDEvents
        .map((event) => event.txHash?.toLowerCase())
        .filter((hash): hash is string => Boolean(hash))
    ),
  ];

  const receiptByTx = new Map<string, RpcLog[]>();
  const enrichedByTx = new Map<string, EnrichedClassDCandidate[]>();
  for (const txHash of txHashes) {
    const blockNumber =
      classDEvents.find((event) => event.txHash?.toLowerCase() === txHash)
        ?.blockNumber ?? 0;
    const fetched = await fetchReceiptLogsForTx({
      txHash,
      blockNumber,
      rpc: options.rpc,
      etherscan: options.etherscan,
    });
    if (fetched.logs) {
      receiptByTx.set(txHash, fetched.logs);
      enrichedByTx.set(
        txHash,
        receiptLogsToEnrichedCandidates(
          fetched.logs,
          normalized,
          blockNumber
        )
      );
    }
  }

  const index = await loadPersistedAuthoritativeIndex(normalized);
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

  let identifiedUniqueMatches = 0;
  let alreadyApplied = 0;
  let newlyApplied = 0;
  let canonicalAlreadySatisfied = 0;
  let legacyDuplicatesRetired = 0;
  let sameWalletEconomicConflicts = 0;
  let applyFailures = 0;
  const applyFailureReasons: Record<string, number> = {};

  for (const event of classDEvents) {
    const txHash = event.txHash?.toLowerCase();
    if (!txHash) continue;
    const logs = receiptByTx.get(txHash);
    if (!logs) continue;
    const match = matchClassDEventToReceipt({
      event,
      receiptLogs: logs,
      enrichedCandidates: enrichedByTx.get(txHash),
    });
    if (match.outcome !== "unique_match") continue;
    identifiedUniqueMatches += 1;
    if (
      event.logIndex != null &&
      event.logIndex >= 0 &&
      classifyChainEventIdentity(event) !== "unresolved_chain_log"
    ) {
      alreadyApplied += 1;
      continue;
    }
    if (match.recoveredLogIndex == null || !match.canonicalIdentity) {
      applyFailures += 1;
      applyFailureReasons.missing_recovery_metadata =
        (applyFailureReasons.missing_recovery_metadata ?? 0) + 1;
      continue;
    }
    const applied = await applyRecoveredMetadata({
      wallet: normalized,
      event,
      recoveredLogIndex: match.recoveredLogIndex,
      canonicalIdentity: match.canonicalIdentity,
      index,
      diagnostics,
    });
    if (applied.outcome === "recovery_applied") {
      newlyApplied += 1;
    } else if (applied.outcome === "canonical_already_satisfied") {
      canonicalAlreadySatisfied += 1;
    } else if (applied.outcome === "legacy_duplicate_retired") {
      legacyDuplicatesRetired += 1;
    } else if (applied.outcome === "economic_conflict") {
      sameWalletEconomicConflicts += 1;
      applyFailures += 1;
      applyFailureReasons.economic_conflict =
        (applyFailureReasons.economic_conflict ?? 0) + 1;
    } else if (applied.outcome === "ambiguous_collision") {
      applyFailures += 1;
      applyFailureReasons.ambiguous_collision =
        (applyFailureReasons.ambiguous_collision ?? 0) + 1;
    } else if (applied.outcome === "row_not_found") {
      applyFailures += 1;
      applyFailureReasons.row_not_found =
        (applyFailureReasons.row_not_found ?? 0) + 1;
    }
  }

  const canonicalAfter = await countCanonicalIdentities(normalized);
  const eventsAfter = await loadPersistedWalletEvents(normalized);
  const remainingLifecycleRelevantUnresolved = assessUnresolvedChainOrder(
    eventsAfter
  ).unresolvedChainEventsInLifecycle;
  const residual = await classifyClassDResidualEvents(normalized);
  const remainingPending = residual.filter(
    (row) => row.outcome === "unique_match"
  ).length;
  const ambiguous = residual.filter(
    (row) => row.outcome === "unresolved_ambiguous_receipt_match"
  ).length;
  const noMatch = residual.filter(
    (row) => row.outcome === "unresolved_no_receipt_match"
  ).length;

  return {
    wallet: normalized,
    rootCause: diagnosis.rootCause,
    beforeUnresolved,
    identifiedUniqueMatches,
    alreadyApplied,
    newlyApplied,
    canonicalAlreadySatisfied,
    legacyDuplicatesRetired,
    sameWalletEconomicConflicts,
    ambiguous,
    noMatch,
    applyFailures,
    applyFailureReasons,
    remainingPending,
    remainingLifecycleRelevantUnresolved,
    canonicalIdentityCountBefore: canonicalBefore,
    canonicalIdentityCountAfter: canonicalAfter,
  };
}

export async function retryInfraFailedTxHashesOnly(
  wallet: string,
  txHashes: string[],
  options: {
    rpc?: PolygonRpcClient;
    etherscan?: EtherscanV2LogProvider;
    apply?: boolean;
  } = {}
): Promise<InfraRetryReport> {
  const normalized = wallet.toLowerCase();
  const uniqueHashes = [
    ...new Set(txHashes.map((hash) => hash.toLowerCase()).filter(Boolean)),
  ];
  invalidateReceiptCache(uniqueHashes);

  const events = await loadPersistedWalletEvents(normalized);
  const classDEvents = filterChainAuthoritativeEvents(events).filter(
    (event) =>
      classifyChainEventIdentity(event) === "unresolved_chain_log" &&
      event.txHash &&
      uniqueHashes.includes(event.txHash.toLowerCase())
  );

  const receiptByTx = new Map<string, RpcLog[]>();
  const enrichedByTx = new Map<string, EnrichedClassDCandidate[]>();
  let rpcRecovered = 0;
  let alternateRpcRecovered = 0;
  let fallbackRecovered = 0;
  let stillInfraFailed = 0;
  const stillInfraFailedTxHashes = new Set<string>();

  for (const txHash of uniqueHashes) {
    const blockNumber =
      classDEvents.find((event) => event.txHash?.toLowerCase() === txHash)
        ?.blockNumber ?? 0;
    const fetched = await fetchReceiptLogsForTx({
      txHash,
      blockNumber,
      rpc: options.rpc,
      etherscan: options.etherscan,
      forceRefetch: true,
    });
    if (fetched.providerFailure) {
      stillInfraFailed += 1;
      stillInfraFailedTxHashes.add(txHash);
      continue;
    }
    if (!fetched.logs) continue;
    if (fetched.fetchResult.recoveredVia === "rpc") rpcRecovered += 1;
    else if (fetched.fetchResult.recoveredVia === "rpc_alternate") {
      alternateRpcRecovered += 1;
    } else if (fetched.fetchResult.recoveredVia === "etherscan") {
      fallbackRecovered += 1;
    }
    receiptByTx.set(txHash, fetched.logs);
    enrichedByTx.set(
      txHash,
      receiptLogsToEnrichedCandidates(fetched.logs, normalized, blockNumber)
    );
  }

  let uniqueMatchesApplied = 0;
  let logIndexRecovered = 0;
  const index =
    options.apply !== false
      ? await loadPersistedAuthoritativeIndex(normalized)
      : null;
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

  for (const event of classDEvents) {
    const txHash = event.txHash?.toLowerCase();
    if (!txHash || stillInfraFailedTxHashes.has(txHash)) continue;
    const logs = receiptByTx.get(txHash);
    if (!logs) continue;
    const match = matchClassDEventToReceipt({
      event,
      receiptLogs: logs,
      enrichedCandidates: enrichedByTx.get(txHash),
    });
    if (match.outcome !== "unique_match") continue;
    if (
      options.apply === false ||
      match.recoveredLogIndex == null ||
      !match.canonicalIdentity ||
      !index
    ) {
      continue;
    }
    const applied = await applyRecoveredMetadata({
      wallet: normalized,
      event,
      recoveredLogIndex: match.recoveredLogIndex,
      canonicalIdentity: match.canonicalIdentity,
      index,
      diagnostics,
    });
    if (
      applied.applied &&
      (applied.outcome === "recovery_applied" ||
        applied.outcome === "legacy_duplicate_retired")
    ) {
      uniqueMatchesApplied += 1;
      logIndexRecovered += 1;
    }
  }

  return {
    wallet: normalized,
    txsRetried: uniqueHashes.length,
    rpcRecovered,
    alternateRpcRecovered,
    fallbackRecovered,
    stillInfraFailed,
    stillInfraFailedTxHashes: [...stillInfraFailedTxHashes].sort(),
    uniqueMatchesApplied,
    logIndexRecovered,
  };
}

export async function buildNormalizedClassDCounts(
  wallet: string,
  classDBeforeLifecycle: number
): Promise<ClassDNormalizedCounts> {
  const normalized = wallet.toLowerCase();
  const classifications = await classifyClassDResidualEvents(normalized);
  const lifecycleKeys = lifecycleUnresolvedKeys(
    await loadPersistedWalletEvents(normalized)
  );

  const uniquePhysical = new Set(classifications.map((row) => row.event.dedupeKey));
  const uniqueTxHashes = new Set(
    classifications
      .map((row) => row.event.txHash?.toLowerCase())
      .filter((hash): hash is string => Boolean(hash))
  );
  const uniqueMatchesFound = classifications.filter(
    (row) => row.outcome === "unique_match"
  ).length;
  const unresolvedAmbiguous = classifications.filter(
    (row) => row.outcome === "unresolved_ambiguous_receipt_match"
  ).length;
  const unresolvedInfra = classifications.filter(
    (row) => row.providerFailure || row.outcome === "receipt_unavailable"
  ).length;
  const unresolvedNoMatch = classifications.filter(
    (row) => row.outcome === "unresolved_no_receipt_match"
  ).length;

  const events = await loadPersistedWalletEvents(normalized);
  const unresolvedAssessment = assessUnresolvedChainOrder(events);
  const recoveredCanonical = filterChainAuthoritativeEvents(events).filter(
    (event) =>
      classifyChainEventIdentity(event) !== "unresolved_chain_log" &&
      event.logIndex != null &&
      event.logIndex >= 0
  ).length;

  return {
    wallet: normalized,
    totalClassDAuthoritativeRows: classifications.length,
    lifecycleRelevantClassDRows: classDBeforeLifecycle,
    uniqueClassDPhysicalEvents: uniquePhysical.size,
    uniqueTxHashes: uniqueTxHashes.size,
    uniqueMatchesFound,
    uniqueMatchesApplied: recoveredCanonical,
    pendingUniqueMatchesNotApplied: uniqueMatchesFound,
    unresolvedAmbiguousPhysicalEvents: unresolvedAmbiguous,
    unresolvedInfraPhysicalEvents: unresolvedInfra,
    unresolvedNoMatchPhysicalEvents: unresolvedNoMatch,
    remainingLifecycleRelevantUnresolved:
      unresolvedAssessment.unresolvedChainEventsInLifecycle,
  };
}

export async function analyzeAmbiguityTaxonomy(
  wallet: string,
  sampleSize = 50
): Promise<AmbiguityTaxonomy> {
  const normalized = wallet.toLowerCase();
  const classifications = await classifyClassDResidualEvents(normalized);
  const ambiguous = classifications.filter(
    (row) => row.outcome === "unresolved_ambiguous_receipt_match"
  );
  const txSeen = new Set<string>();
  const categories: Record<string, number> = {};
  let resolvedByDisambiguation = 0;
  let inspectedTxCount = 0;

  for (const row of ambiguous) {
    const txHash = row.event.txHash?.toLowerCase();
    if (!txHash || txSeen.has(txHash)) continue;
    if (txSeen.size >= sampleSize) break;
    txSeen.add(txHash);
    inspectedTxCount += 1;

    const blockNumber = row.event.blockNumber ?? 0;
    const fetched = await fetchReceiptLogsForTx({ txHash, blockNumber });
    if (!fetched.logs) continue;
    const enriched = receiptLogsToEnrichedCandidates(
      fetched.logs,
      normalized,
      blockNumber
    );
    const category = classifyAmbiguityRootCause(row.event, enriched);
    categories[category] = (categories[category] ?? 0) + 1;
    if (disambiguateClassDCandidates(row.event, enriched)) {
      resolvedByDisambiguation += 1;
    }
  }

  return {
    wallet: normalized,
    inspectedTxCount,
    categories,
    resolvedByDisambiguation,
    remainingAmbiguous: ambiguous.length - resolvedByDisambiguation,
  };
}

export async function classifyClassDResidualEvents(
  wallet: string,
  options: {
    rpc?: PolygonRpcClient;
    etherscan?: EtherscanV2LogProvider;
    forceRefetchTxHashes?: string[];
  } = {}
): Promise<ClassDResidualEventClassification[]> {
  const normalized = wallet.toLowerCase();
  const events = await loadPersistedWalletEvents(normalized);
  const classDEvents = filterChainAuthoritativeEvents(events).filter(
    (event) => classifyChainEventIdentity(event) === "unresolved_chain_log"
  );
  const lifecycleKeys = lifecycleUnresolvedKeys(events);
  const forceRefetch = new Set(
    (options.forceRefetchTxHashes ?? []).map((hash) => hash.toLowerCase())
  );
  if (forceRefetch.size > 0) {
    invalidateReceiptCache([...forceRefetch]);
  }

  const txHashes = [
    ...new Set(
      classDEvents
        .map((event) => event.txHash?.toLowerCase())
        .filter((hash): hash is string => Boolean(hash))
    ),
  ];

  const receiptByTx = new Map<string, RpcLog[]>();
  const enrichedByTx = new Map<string, EnrichedClassDCandidate[]>();
  const providerFailureTx = new Set<string>();

  for (const txHash of txHashes) {
    const blockNumber =
      classDEvents.find((event) => event.txHash?.toLowerCase() === txHash)
        ?.blockNumber ?? 0;
    const fetched = await fetchReceiptLogsForTx({
      txHash,
      blockNumber,
      rpc: options.rpc,
      etherscan: options.etherscan,
      forceRefetch: forceRefetch.has(txHash),
    });
    if (fetched.providerFailure) {
      providerFailureTx.add(txHash);
      continue;
    }
    if (!fetched.logs) continue;
    receiptByTx.set(txHash, fetched.logs);
    enrichedByTx.set(
      txHash,
      receiptLogsToEnrichedCandidates(fetched.logs, normalized, blockNumber)
    );
  }

  const classifications: ClassDResidualEventClassification[] = [];
  for (const event of classDEvents) {
    const inLifecycle = lifecycleKeys.has(event.dedupeKey);
    const txHash = event.txHash?.toLowerCase();
    if (!txHash) {
      classifications.push({
        event,
        outcome: "missing_tx_hash",
        inLifecycle,
        providerFailure: false,
      });
      continue;
    }
    if (providerFailureTx.has(txHash)) {
      classifications.push({
        event,
        outcome: "receipt_unavailable",
        inLifecycle,
        providerFailure: true,
      });
      continue;
    }
    const logs = receiptByTx.get(txHash) ?? [];
    const match = matchClassDEventToReceipt({
      event,
      receiptLogs: logs,
      enrichedCandidates: enrichedByTx.get(txHash),
    });
    classifications.push({
      event,
      outcome: match.outcome,
      inLifecycle,
      providerFailure: false,
    });
  }
  return classifications;
}

export async function analyzeClassDRecoveryResiduals(
  wallet: string,
  input: {
    classDBeforeLifecycle: number;
    sampleSize?: number;
    forceRefetchTxHashes?: string[];
    apply?: boolean;
  }
): Promise<ClassDResidualTaxonomy> {
  const normalized = wallet.toLowerCase();
  const classifications = await classifyClassDResidualEvents(normalized, {
    forceRefetchTxHashes: input.forceRefetchTxHashes,
  });

  const lifecycleUnresolved = classifications.filter(
    (row) =>
      row.inLifecycle &&
      row.outcome !== "unique_match"
  );

  const matchPass = {
    uniqueMatch: 0,
    noReceiptMatch: 0,
    ambiguousMatch: 0,
    missingTxHash: 0,
  };
  const infrastructure = {
    providerFailureEvents: 0,
    providerFailureTxHashes: [] as string[],
    receiptUnavailableEvents: 0,
  };
  const genuineUnresolved = {
    noReceiptMatch: 0,
    ambiguousMatch: 0,
    missingTxHash: 0,
  };

  const providerTxSet = new Set<string>();
  const noReceiptEvents: ClassDResidualEventClassification[] = [];
  const ambiguousEvents: ClassDResidualEventClassification[] = [];
  const decodedByTx = new Map<string, WalletLedgerEvent[]>();

  for (const row of classifications) {
    if (row.outcome === "unique_match") {
      matchPass.uniqueMatch += 1;
      continue;
    }
    if (row.outcome === "missing_tx_hash") {
      matchPass.missingTxHash += 1;
      genuineUnresolved.missingTxHash += 1;
      continue;
    }
    if (row.outcome === "receipt_unavailable" || row.providerFailure) {
      infrastructure.receiptUnavailableEvents += 1;
      infrastructure.providerFailureEvents += 1;
      if (row.event.txHash) providerTxSet.add(row.event.txHash.toLowerCase());
      continue;
    }
    if (row.outcome === "unresolved_no_receipt_match") {
      matchPass.noReceiptMatch += 1;
      genuineUnresolved.noReceiptMatch += 1;
      noReceiptEvents.push(row);
    } else if (row.outcome === "unresolved_ambiguous_receipt_match") {
      matchPass.ambiguousMatch += 1;
      genuineUnresolved.ambiguousMatch += 1;
      ambiguousEvents.push(row);
    }
  }
  infrastructure.providerFailureTxHashes = [...providerTxSet].sort();

  const events = await loadPersistedWalletEvents(normalized);
  const unresolvedAssessment = assessUnresolvedChainOrder(events);

  const lifecycleTxHashes = new Set(
    lifecycleUnresolved
      .map((row) => row.event.txHash?.toLowerCase())
      .filter((hash): hash is string => Boolean(hash))
  );

  for (const txHash of [
    ...new Set(
      [...noReceiptEvents, ...ambiguousEvents]
        .map((row) => row.event.txHash?.toLowerCase())
        .filter((hash): hash is string => Boolean(hash))
    ),
  ]) {
    if (!decodedByTx.has(txHash)) {
      const sample = [...noReceiptEvents, ...ambiguousEvents].find(
        (row) => row.event.txHash?.toLowerCase() === txHash
      );
      if (!sample) continue;
      const result = await fetchTransactionReceiptCached({ txHash });
      const logs = result.receipt?.logs ?? [];
      decodedByTx.set(
        txHash,
        receiptLogsToLedgerCandidates(
          logs,
          sample.event.wallet,
          sample.event.blockNumber ?? 0
        )
      );
    }
  }

  const sampleSize = input.sampleSize ?? 20;
  const noReceiptMatchSamples = noReceiptEvents.slice(0, sampleSize).map((row) =>
    diagnoseNoReceiptMatch(
      row.event,
      decodedByTx.get(row.event.txHash?.toLowerCase() ?? "") ?? []
    )
  );

  const ambiguousMatchSamples = ambiguousEvents.slice(0, sampleSize).map((row) => {
    const decoded =
      decodedByTx.get(row.event.txHash?.toLowerCase() ?? "") ?? [];
    const match = matchClassDEventToReceipt({
      event: row.event,
      receiptLogs: [],
      decodedCandidates: decoded,
    });
    const candidates = decoded.filter((candidate) =>
      economicallyEquivalent(row.event, candidate)
    );
    return {
      dedupeKey: row.event.dedupeKey,
      txHash: row.event.txHash ?? null,
      blockNumber: row.event.blockNumber ?? null,
      type: row.event.type,
      asset: row.event.asset ?? "",
      shares: row.event.shares ?? null,
      cashUsd: row.event.cashUsd ?? null,
      candidateLogIndexes: match.candidateLogIndexes ?? [],
      candidateSummary: candidates.slice(0, 5).map((candidate) => ({
        logIndex: candidate.logIndex ?? -1,
        type: candidate.type,
        asset: candidate.asset ?? "",
        shares: candidate.shares ?? null,
        cashUsd: candidate.cashUsd ?? null,
      })),
    } satisfies AmbiguousMatchDiagnostic;
  });

  let applyStats: ClassDResidualTaxonomy["applyStats"];
  if (input.apply) {
    const recovery = await recoverClassDEventsForWallet(normalized, { apply: true });
    applyStats = {
      canonicalized: recovery.canonicalized,
      economicConflicts: recovery.economicConflicts,
    };
  }

  return {
    wallet: normalized,
    classDBeforeLifecycle: input.classDBeforeLifecycle,
    currentClassDTotal: classifications.length,
    currentClassDInLifecycle: lifecycleUnresolved.length,
    matchPass,
    infrastructure,
    genuineUnresolved,
    remaining: {
      lifecycleRelevantUnresolved:
        unresolvedAssessment.unresolvedChainEventsInLifecycle,
      uniqueTxHashesAmongLifecycleUnresolved: lifecycleTxHashes.size,
      affectedPositionGroups: unresolvedAssessment.affectedPositionGroups,
    },
    applyStats,
    noReceiptMatchSamples,
    ambiguousMatchSamples,
  };
}

export async function retryProviderFailedClassDRecovery(
  wallet: string,
  txHashes: string[],
  options: { apply?: boolean } = {}
): Promise<InfraRetryReport> {
  return retryInfraFailedTxHashesOnly(wallet, txHashes, options);
}

export async function recoverClassDEventsForWallet(
  wallet: string,
  options: {
    rpc?: PolygonRpcClient;
    etherscan?: EtherscanV2LogProvider;
    apply?: boolean;
  } = {}
): Promise<ClassDRecoveryReport> {
  const normalized = wallet.toLowerCase();
  const events = await loadPersistedWalletEvents(normalized);
  const authoritative = filterChainAuthoritativeEvents(events);
  const classDEvents = authoritative.filter(
    (event) => classifyChainEventIdentity(event) === "unresolved_chain_log"
  );

  const txHashes = [
    ...new Set(
      classDEvents
        .map((event) => event.txHash?.toLowerCase())
        .filter((hash): hash is string => Boolean(hash))
    ),
  ];

  const receiptByTx = new Map<string, RpcLog[]>();
  const enrichedByTx = new Map<string, EnrichedClassDCandidate[]>();
  let receiptsFetched = 0;
  let receiptCacheHits = 0;
  let providerFailures = 0;

  for (const txHash of txHashes) {
    const blockNumber =
      classDEvents.find((event) => event.txHash?.toLowerCase() === txHash)
        ?.blockNumber ?? 0;
    const fetched = await fetchReceiptLogsForTx({
      txHash,
      blockNumber,
      rpc: options.rpc,
      etherscan: options.etherscan,
    });
    if (fetched.fetchResult.cacheHit) receiptCacheHits += 1;
    else if (fetched.logs) receiptsFetched += 1;
    if (fetched.providerFailure) {
      providerFailures += 1;
      continue;
    }
    if (!fetched.logs) continue;
    receiptByTx.set(txHash, fetched.logs);
    enrichedByTx.set(
      txHash,
      receiptLogsToEnrichedCandidates(fetched.logs, normalized, blockNumber)
    );
  }

  let uniqueMatches = 0;
  let ambiguousMatches = 0;
  let noMatches = 0;
  let logIndexRecovered = 0;
  let canonicalized = 0;
  let economicConflicts = 0;
  let ambiguousCollisions = 0;

  const reconciliationIndex = options.apply !== false
    ? await loadPersistedAuthoritativeIndex(normalized)
    : null;
  const reconciliationDiagnostics: CanonicalReconciliationDiagnostics = {
    canonicalMatches: 0,
    physicalCoordinateMatches: 0,
    canonicalDedupeKeyBackfills: 0,
    legacyCoordinateBackfills: 0,
    newCanonicalInserts: 0,
    ambiguousCollisions: 0,
    economicConflicts: 0,
    crossWalletDedupeSatisfied: 0,
  };

  for (const event of classDEvents) {
    const txHash = event.txHash?.toLowerCase();
    if (!txHash) {
      noMatches += 1;
      continue;
    }
    const logs = receiptByTx.get(txHash);
    if (!logs) {
      providerFailures += 1;
      continue;
    }
    const match = matchClassDEventToReceipt({
      event,
      receiptLogs: logs,
      enrichedCandidates: enrichedByTx.get(txHash),
    });
    if (match.outcome === "unique_match") {
      uniqueMatches += 1;
      if (options.apply !== false && match.recoveredLogIndex != null && match.canonicalIdentity) {
        const applied = await applyRecoveredMetadata({
          wallet: normalized,
          event,
          recoveredLogIndex: match.recoveredLogIndex,
          canonicalIdentity: match.canonicalIdentity,
          index: reconciliationIndex!,
          diagnostics: reconciliationDiagnostics,
        });
        if (applied.outcome === "economic_conflict") {
          economicConflicts += 1;
        } else if (applied.outcome === "ambiguous_collision") {
          ambiguousCollisions += 1;
        } else if (
          applied.applied &&
          (applied.outcome === "recovery_applied" ||
            applied.outcome === "legacy_duplicate_retired" ||
            applied.outcome === "canonical_already_satisfied")
        ) {
          logIndexRecovered += 1;
          canonicalized += 1;
        }
      }
    } else if (match.outcome === "unresolved_ambiguous_receipt_match") {
      ambiguousMatches += 1;
    } else if (match.outcome === "provider_failure") {
      providerFailures += 1;
    } else {
      noMatches += 1;
    }
  }

  const reloaded = await loadPersistedWalletEvents(normalized);
  const unresolvedAssessment = assessUnresolvedChainOrder(reloaded);

  return {
    wallet: normalized,
    beforeClassD: classDEvents.length,
    uniqueTxHashes: txHashes.length,
    receiptsFetched,
    receiptCacheHits,
    uniqueMatches,
    ambiguousMatches,
    noMatches,
    providerFailures,
    logIndexRecovered,
    canonicalized,
    remainingUnresolved: unresolvedAssessment.unresolvedChainEvents,
    remainingUnresolvedInLifecycle:
      unresolvedAssessment.unresolvedChainEventsInLifecycle,
    affectedPositionGroups: unresolvedAssessment.affectedPositionGroups,
    economicConflicts,
    ambiguousCollisions,
  };
}
