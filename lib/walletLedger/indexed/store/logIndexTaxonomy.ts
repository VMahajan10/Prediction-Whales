import { hasFullCanonicalChainOrder } from "@/lib/walletLedger/eventOrder";
import {
  buildChainCoordinateLogIndexLookup,
  chainCoordinateLogIndexKey,
} from "@/lib/walletLedger/indexed/store/eventMetadataEnrichment";
import { isChainAuthoritativeEvent } from "@/lib/walletLedger/indexed/store/authoritativePersistence";
import type { WalletLedgerEvent } from "@/lib/walletLedger/types";

export type LogIndexGapCategory =
  | "normalization_dropped"
  | "persist_or_merge_lost"
  | "non_log_synthetic"
  | "unmatched_identity";

export interface LogIndexGapRow {
  dedupeKey: string;
  category: LogIndexGapCategory;
  blockNumber: number | null;
  txHash: string | null;
  type: string;
}

export interface LogIndexTaxonomyReport {
  totalAuthoritative: number;
  expectingLogIndex: number;
  withLogIndex: number;
  missingLogIndex: number;
  countsByCategory: Record<LogIndexGapCategory, number>;
  samplesByCategory: Record<LogIndexGapCategory, LogIndexGapRow[]>;
}

const MAX_SAMPLES = 5;

function recordSample(
  samples: Record<LogIndexGapCategory, LogIndexGapRow[]>,
  row: LogIndexGapRow
): void {
  const bucket = samples[row.category];
  if (bucket.length >= MAX_SAMPLES) return;
  bucket.push(row);
}

export function classifyAuthoritativeLogIndexGap(input: {
  event: WalletLedgerEvent;
  chainLogIndexLookup: Map<string, number>;
  rawLogIndexByTxLog?: Map<string, number>;
}): LogIndexGapCategory {
  const { event, chainLogIndexLookup, rawLogIndexByTxLog } = input;
  if (!isChainAuthoritativeEvent(event)) {
    return "non_log_synthetic";
  }
  if ((event.blockNumber ?? 0) <= 0 || !event.txHash) {
    return "non_log_synthetic";
  }
  if (hasFullCanonicalChainOrder(event)) {
    return "non_log_synthetic";
  }

  const coordinateKey = chainCoordinateLogIndexKey(event);
  if (coordinateKey != null && chainLogIndexLookup.has(coordinateKey)) {
    return "persist_or_merge_lost";
  }

  if (rawLogIndexByTxLog) {
    const rawKeys = [...rawLogIndexByTxLog.keys()].filter((key) =>
      key.startsWith(`${event.txHash!.toLowerCase()}:`)
    );
    if (rawKeys.length > 0) {
      return "normalization_dropped";
    }
  }

  return "unmatched_identity";
}

export function buildLogIndexTaxonomyReport(input: {
  authoritativeEvents: WalletLedgerEvent[];
  chainLogIndexLookup?: Map<string, number>;
  rawLogIndexByTxLog?: Map<string, number>;
}): LogIndexTaxonomyReport {
  const chainLogIndexLookup =
    input.chainLogIndexLookup ??
    buildChainCoordinateLogIndexLookup(input.authoritativeEvents);
  const countsByCategory: Record<LogIndexGapCategory, number> = {
    normalization_dropped: 0,
    persist_or_merge_lost: 0,
    non_log_synthetic: 0,
    unmatched_identity: 0,
  };
  const samplesByCategory: Record<LogIndexGapCategory, LogIndexGapRow[]> = {
    normalization_dropped: [],
    persist_or_merge_lost: [],
    non_log_synthetic: [],
    unmatched_identity: [],
  };

  let expectingLogIndex = 0;
  let withLogIndex = 0;
  let missingLogIndex = 0;

  for (const event of input.authoritativeEvents) {
    if (!isChainAuthoritativeEvent(event)) continue;
    if ((event.blockNumber ?? 0) <= 0 || !event.txHash) {
      countsByCategory.non_log_synthetic += 1;
      recordSample(samplesByCategory, {
        dedupeKey: event.dedupeKey,
        category: "non_log_synthetic",
        blockNumber: event.blockNumber ?? null,
        txHash: event.txHash ?? null,
        type: event.type,
      });
      continue;
    }
    expectingLogIndex += 1;
    if (hasFullCanonicalChainOrder(event)) {
      withLogIndex += 1;
      continue;
    }
    missingLogIndex += 1;
    const category = classifyAuthoritativeLogIndexGap({
      event,
      chainLogIndexLookup,
      rawLogIndexByTxLog: input.rawLogIndexByTxLog,
    });
    countsByCategory[category] += 1;
    recordSample(samplesByCategory, {
      dedupeKey: event.dedupeKey,
      category,
      blockNumber: event.blockNumber ?? null,
      txHash: event.txHash ?? null,
      type: event.type,
    });
  }

  return {
    totalAuthoritative: input.authoritativeEvents.length,
    expectingLogIndex,
    withLogIndex,
    missingLogIndex,
    countsByCategory,
    samplesByCategory,
  };
}

/**
 * Backfill logIndex on authoritative events using chain-coordinate lookup from
 * events that already captured logIndex. Does not synthesize fake logIndex.
 */
export function backfillAuthoritativeLogIndexFromLookup(
  events: WalletLedgerEvent[],
  lookup?: Map<string, number>
): { events: WalletLedgerEvent[]; backfilled: number } {
  const chainLogIndexLookup =
    lookup ?? buildChainCoordinateLogIndexLookup(events);
  let backfilled = 0;
  const updated = events.map((event) => {
    if (hasFullCanonicalChainOrder(event)) return event;
    const coordinateKey = chainCoordinateLogIndexKey(event);
    if (!coordinateKey) return event;
    const logIndex = chainLogIndexLookup.get(coordinateKey);
    if (logIndex == null || logIndex < 0) return event;
    backfilled += 1;
    return { ...event, logIndex };
  });
  return { events: updated, backfilled };
}
