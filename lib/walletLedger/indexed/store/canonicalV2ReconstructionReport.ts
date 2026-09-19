import {
  authoritativeEventMergeKey,
  classifyChainEventIdentity,
  hashCanonicalAuthoritativeIdentities,
  type ChainEventIdentityClass,
} from "@/lib/walletLedger/canonicalChainIdentity";
import { hasFullCanonicalChainOrder } from "@/lib/walletLedger/eventOrder";
import { AUTHORITATIVE_COVERAGE_FINGERPRINT_VERSION } from "@/lib/walletLedger/indexed/store/authoritativeCoverageFingerprint";
import { buildAuthoritativeCoverageFingerprint } from "@/lib/walletLedger/indexed/store/authoritativeCoverageFingerprint";
import {
  filterChainAuthoritativeEvents,
  hashAuthoritativeEventIdentities,
} from "@/lib/walletLedger/indexed/store/authoritativePersistence";
import type { IndexedAuditWalletResult } from "@/lib/walletLedger/indexed/types";
import type { WalletLedgerEvent } from "@/lib/walletLedger/types";

export interface CanonicalV2ReconstructionReport {
  runLabel: string;
  wallet: string;
  provider: string;
  fingerprintVersion: string;
  scanFromBlock: number;
  throughBlock: number;
  queryPlanVersion: string;
  rawProviderLogs: number;
  parsedLogs: number;
  normalizedChainEvents: number;
  persistedBaselineEvents: number;
  deltaChainEvents: number;
  canonicalIdentitiesBeforeMerge: number;
  duplicateCanonicalIdentitiesCollapsed: number;
  finalAuthoritativeCanonicalCount: number;
  canonicalIdentityHash: string;
  minBlock: number | null;
  maxBlock: number | null;
  countByContract: Record<string, number>;
  countByEventType: Record<string, number>;
  unresolvedClassD: number;
  missingLogIndex: number;
  classCounts: Record<ChainEventIdentityClass, number>;
  coverageFingerprintHash: string;
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

function countByField(
  events: WalletLedgerEvent[],
  field: "type" | "contract"
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const event of events) {
    const key =
      field === "type"
        ? event.type
        : event.txHash?.slice(0, 10) ?? "no_tx";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

export function buildCanonicalV2ReconstructionReport(input: {
  runLabel: string;
  audit: IndexedAuditWalletResult;
  persistedBaselineEvents: number;
}): CanonicalV2ReconstructionReport {
  const audit = input.audit;
  const delta = audit.indexedEvents ?? [];
  const authoritative = filterChainAuthoritativeEvents(
    audit.authoritativeIndexedEvents ?? []
  );
  const funnel = audit.debugReport?.funnelBySubject ?? {};
  let parsedLogs = 0;
  let normalizedChainEvents = 0;
  for (const subject of Object.keys(funnel)) {
    parsedLogs += funnel[subject]?.rawLogs ?? 0;
    normalizedChainEvents += funnel[subject]?.finalIndexedEvents ?? 0;
  }

  const deltaCanonicalKeys = new Set(
    delta
      .filter((event) => event.source === "polygon")
      .map((event) => authoritativeEventMergeKey(event))
  );
  const authoritativeCanonicalKeys = new Set(
    authoritative.map((event) => authoritativeEventMergeKey(event))
  );
  const duplicateCanonicalIdentitiesCollapsed = Math.max(
    0,
    deltaCanonicalKeys.size +
      input.persistedBaselineEvents -
      authoritativeCanonicalKeys.size
  );

  const classCounts: Record<ChainEventIdentityClass, number> = {
    canonical_chain_log: 0,
    recoverable_chain_log: 0,
    synthetic_non_log: 0,
    unresolved_chain_log: 0,
  };
  let missingLogIndex = 0;
  for (const event of authoritative) {
    const className = classifyChainEventIdentity(event);
    classCounts[className] += 1;
    if (
      className === "canonical_chain_log" &&
      !hasFullCanonicalChainOrder(event)
    ) {
      missingLogIndex += 1;
    }
  }

  const { minBlock, maxBlock } = blockRange(authoritative);
  const perContractFromBlock: Record<string, number> = {};
  for (const query of audit.debugReport?.queryPlan?.queries ?? []) {
    perContractFromBlock[query.contract] = query.fromBlock;
  }
  const fingerprint = buildAuthoritativeCoverageFingerprint({
    wallet: audit.wallet,
    provider: audit.providerId,
    perContractFromBlock,
    throughBlock: audit.throughBlock ?? 0,
    querySubjects: audit.debugReport?.scanSubjects ?? [audit.wallet],
    authoritativeEvents: authoritative,
  });

  return {
    runLabel: input.runLabel,
    wallet: audit.wallet.toLowerCase(),
    provider: audit.providerId,
    fingerprintVersion: AUTHORITATIVE_COVERAGE_FINGERPRINT_VERSION,
    scanFromBlock: audit.scanFromBlock ?? 0,
    throughBlock: audit.throughBlock ?? 0,
    queryPlanVersion: fingerprint.queryPlanVersion,
    rawProviderLogs: audit.fetchStats?.logsReturned ?? 0,
    parsedLogs,
    normalizedChainEvents,
    persistedBaselineEvents: input.persistedBaselineEvents,
    deltaChainEvents: delta.length,
    canonicalIdentitiesBeforeMerge: deltaCanonicalKeys.size,
    duplicateCanonicalIdentitiesCollapsed,
    finalAuthoritativeCanonicalCount: authoritative.length,
    canonicalIdentityHash: hashAuthoritativeEventIdentities(authoritative),
    minBlock,
    maxBlock,
    countByContract: countByField(authoritative, "contract"),
    countByEventType: countByField(authoritative, "type"),
    unresolvedClassD: classCounts.unresolved_chain_log,
    missingLogIndex,
    classCounts,
    coverageFingerprintHash: fingerprint.fingerprintHash,
  };
}

export function diffCanonicalV2Reports(
  cold: CanonicalV2ReconstructionReport,
  resumed: CanonicalV2ReconstructionReport,
  coldEvents: WalletLedgerEvent[],
  resumedEvents: WalletLedgerEvent[]
): {
  countMatch: boolean;
  hashMatch: boolean;
  onlyInCold: string[];
  onlyInResumed: string[];
  gatePass: boolean;
} {
  const coldKeys = new Set(
    filterChainAuthoritativeEvents(coldEvents).map((event) =>
      authoritativeEventMergeKey(event)
    )
  );
  const resumedKeys = new Set(
    filterChainAuthoritativeEvents(resumedEvents).map((event) =>
      authoritativeEventMergeKey(event)
    )
  );
  const onlyInCold = [...coldKeys].filter((key) => !resumedKeys.has(key)).sort();
  const onlyInResumed = [...resumedKeys]
    .filter((key) => !coldKeys.has(key))
    .sort();
  const countMatch =
    cold.finalAuthoritativeCanonicalCount ===
    resumed.finalAuthoritativeCanonicalCount;
  const hashMatch = cold.canonicalIdentityHash === resumed.canonicalIdentityHash;
  const gatePass =
    countMatch &&
    hashMatch &&
    onlyInCold.length === 0 &&
    onlyInResumed.length === 0;

  return {
    countMatch,
    hashMatch,
    onlyInCold,
    onlyInResumed,
    gatePass,
  };
}
