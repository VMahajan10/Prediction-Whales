import { createHash } from "node:crypto";
import {
  filterChainAuthoritativeEvents,
  hashAuthoritativeEventIdentities,
} from "@/lib/walletLedger/indexed/store/authoritativePersistence";
import type { IndexedAuditWalletResult } from "@/lib/walletLedger/indexed/types";
import type { WalletLedgerEvent } from "@/lib/walletLedger/types";

export interface AuthoritativeReconstructionStageCounts {
  rawLogsPerQuery: Record<string, number>;
  normalizedChainEvents: number;
  dedupedIndexedEvents: number;
  persistedBaselineEvents: number;
  deltaEvents: number;
  authoritativeMergedEvents: number;
  authoritativeIdentityHash: string;
  minBlock: number | null;
  maxBlock: number | null;
  countPerContract: Record<string, number>;
  countPerEventType: Record<string, number>;
}

export interface AuthoritativeReconstructionDiff {
  onlyInCold: string[];
  onlyInResumed: string[];
  contractsResponsible: Record<string, number>;
  queryRangesResponsible: Record<string, number>;
  diagnosis: string;
}

function countByField(
  events: WalletLedgerEvent[],
  field: "type" | "contract"
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const event of events) {
    const key =
      field === "type"
        ? event.type
        : event.txHash
          ? (event.txHash.slice(0, 10) ?? "unknown")
          : "no_tx";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function blockRange(events: WalletLedgerEvent[]): {
  minBlock: number | null;
  maxBlock: number | null;
} {
  let minBlock: number | null = null;
  let maxBlock: number | null = null;
  for (const event of events) {
    const block = event.blockNumber ?? 0;
    if (block <= 0) continue;
    minBlock = minBlock == null ? block : Math.min(minBlock, block);
    maxBlock = maxBlock == null ? block : Math.max(maxBlock, block);
  }
  return { minBlock, maxBlock };
}

export function buildAuthoritativeReconstructionReport(input: {
  runLabel: string;
  audit: IndexedAuditWalletResult;
  persistedBaselineEvents: number;
  rawLogsPerQuery?: Record<string, number>;
}): AuthoritativeReconstructionStageCounts {
  const authoritative = filterChainAuthoritativeEvents(
    input.audit.authoritativeIndexedEvents ?? []
  );
  const delta = input.audit.indexedEvents ?? [];
  const { minBlock, maxBlock } = blockRange(authoritative);
  const funnel = input.audit.debugReport?.funnelBySubject ?? {};
  let normalizedChainEvents = 0;
  for (const subject of Object.keys(funnel)) {
    normalizedChainEvents += funnel[subject]?.finalIndexedEvents ?? 0;
  }

  return {
    rawLogsPerQuery: input.rawLogsPerQuery ?? {},
    normalizedChainEvents,
    dedupedIndexedEvents: delta.length,
    persistedBaselineEvents: input.persistedBaselineEvents,
    deltaEvents: delta.length,
    authoritativeMergedEvents: authoritative.length,
    authoritativeIdentityHash: hashAuthoritativeEventIdentities(authoritative),
    minBlock,
    maxBlock,
    countPerContract: countByField(authoritative, "contract"),
    countPerEventType: countByField(authoritative, "type"),
  };
}

export function diffAuthoritativeReconstructionReports(
  cold: AuthoritativeReconstructionStageCounts,
  resumed: AuthoritativeReconstructionStageCounts,
  coldEvents: WalletLedgerEvent[],
  resumedEvents: WalletLedgerEvent[]
): AuthoritativeReconstructionDiff {
  const coldKeys = new Set(
    filterChainAuthoritativeEvents(coldEvents).map((event) => event.dedupeKey)
  );
  const resumedKeys = new Set(
    filterChainAuthoritativeEvents(resumedEvents).map((event) => event.dedupeKey)
  );
  const onlyInCold = [...coldKeys].filter((key) => !resumedKeys.has(key)).sort();
  const onlyInResumed = [...resumedKeys]
    .filter((key) => !coldKeys.has(key))
    .sort();

  const contractsResponsible: Record<string, number> = {};
  const queryRangesResponsible: Record<string, number> = {};
  const coldByKey = new Map(
    filterChainAuthoritativeEvents(coldEvents).map((event) => [
      event.dedupeKey,
      event,
    ])
  );
  const resumedByKey = new Map(
    filterChainAuthoritativeEvents(resumedEvents).map((event) => [
      event.dedupeKey,
      event,
    ])
  );

  for (const key of onlyInCold) {
    const event = coldByKey.get(key);
    if (!event?.blockNumber) continue;
    const bucket = `${Math.floor(event.blockNumber / 1_000_000)}m`;
    queryRangesResponsible[bucket] = (queryRangesResponsible[bucket] ?? 0) + 1;
    const contract = event.txHash?.slice(0, 10) ?? "unknown";
    contractsResponsible[contract] = (contractsResponsible[contract] ?? 0) + 1;
  }
  for (const key of onlyInResumed) {
    const event = resumedByKey.get(key);
    if (!event?.blockNumber) continue;
    const bucket = `${Math.floor(event.blockNumber / 1_000_000)}m`;
    queryRangesResponsible[bucket] = (queryRangesResponsible[bucket] ?? 0) + 1;
    const contract = event.txHash?.slice(0, 10) ?? "unknown";
    contractsResponsible[contract] = (contractsResponsible[contract] ?? 0) + 1;
  }

  let diagnosis = "authoritative identity sets match";
  if (onlyInCold.length > 0 && onlyInResumed.length === 0) {
    diagnosis = "resumed run appears incomplete relative to cold reconstruction";
  } else if (onlyInResumed.length > 0 && onlyInCold.length === 0) {
    diagnosis = "resumed run double-counted or cold run under-fetched";
  } else if (onlyInCold.length > 0 || onlyInResumed.length > 0) {
    diagnosis =
      "both runs diverged — inspect per-range deltas for missing vs extra identities";
  }

  return {
    onlyInCold,
    onlyInResumed,
    contractsResponsible,
    queryRangesResponsible,
    diagnosis,
  };
}

export function hashEventIdentityList(events: WalletLedgerEvent[]): string {
  const keys = filterChainAuthoritativeEvents(events)
    .map((event) => event.dedupeKey)
    .sort();
  return createHash("sha256").update(keys.join("\n")).digest("hex");
}
