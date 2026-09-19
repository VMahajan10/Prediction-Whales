#!/usr/bin/env tsx
/**
 * Read-only Policy A class-D safety audit for Batch-2 concurrency gate.
 */
import "../tests/preload-env";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { getDb, isDatabaseEnabled } from "@/lib/crossmarket/store/db";
import {
  walletHistoricalMetrics,
  walletHistoryCoverage,
} from "@/lib/crossmarket/store/schema";
import {
  assignChainEventDedupeKey,
  buildCanonicalChainLogIdentity,
  classifyChainEventIdentity,
  hasCanonicalChainLogCoordinates,
  isLegacyTimestampBearingChainDedupeKey,
  legacyTimestampNeutralDedupeKey,
} from "@/lib/walletLedger/canonicalChainIdentity";
import { evaluateHistoricalPerformanceVerdict } from "@/lib/walletLedger/indexed/historicalPerformanceVerdict";
import { WALLET_METRIC_VERSION } from "@/lib/walletLedger/indexed/metricVersion";
import {
  filterChainAuthoritativeEvents,
  filterPersistableAuthoritativeEvents,
  isPersistableAuthoritativeEvent,
} from "@/lib/walletLedger/indexed/store/authoritativePersistence";
import { buildLogIndexTaxonomyReport } from "@/lib/walletLedger/indexed/store/logIndexTaxonomy";
import { loadPersistedWalletEvents } from "@/lib/walletLedger/indexed/store/persistWalletHistory";
import {
  buildLifecycleInput,
  prepareAuthoritativeEventsForLifecycleMerge,
  replayMetricsFromValidationSnapshot,
  type WalletValidationSnapshot,
} from "@/lib/walletLedger/indexed/store/validationSnapshot";
import { assessUnresolvedChainOrder } from "@/lib/walletLedger/indexed/store/unresolvedChainOrder";
import { computeWalletLedgerMetrics } from "@/lib/walletLedger/metrics";
import { buildPositionLifecycles } from "@/lib/walletLedger/ledger";
import { GammaResolutionCache } from "@/lib/walletLedger/gamma";
import { analyzeMergeSplitImpact } from "@/lib/walletLedger/mergeSplitAnalysis";

const WALLETS = [
  "0x2a69660046d7acc4ab204d7cc5ba78b0776cd2f7",
  "0x40b96182a35fbe3c2bb4162e036ecf0c786db002",
  "0x4e56f1ddaa8f5328036c449b89e731ec748cdee1",
];

type TaxonomyCategory =
  | "A_duplicate_legacy_representation"
  | "B_api_normalized_in_authoritative"
  | "C_real_chain_logindex_lost"
  | "D_synthetic_non_log"
  | "E_genuinely_unresolved_physical"
  | "F_other";

function loadLatestSnapshot(wallet: string): WalletValidationSnapshot | null {
  const dir = join(process.cwd(), ".cache", "wallet-validation-snapshots");
  const prefix = wallet.toLowerCase();
  const match = readdirSync(dir)
    .filter((file) => file.startsWith(prefix))
    .sort()
    .at(-1);
  if (!match) return null;
  return JSON.parse(
    readFileSync(join(dir, match), "utf8")
  ) as WalletValidationSnapshot;
}

function round6(value: number | undefined): string {
  if (value == null || !Number.isFinite(value)) return "";
  return value.toFixed(6);
}

function economicMatchKey(event: WalletLedgerEvent): string {
  return [
    event.wallet.toLowerCase(),
    (event.txHash ?? "").toLowerCase(),
    event.blockNumber ?? "",
    event.type,
    event.asset ?? "",
    event.conditionId ?? "",
    round6(event.shares),
    round6(event.cashUsd),
  ].join("|");
}

function buildCanonicalIndex(
  events: WalletLedgerEvent[]
): Map<string, WalletLedgerEvent[]> {
  const index = new Map<string, WalletLedgerEvent[]>();
  for (const event of events) {
    if (event.source !== "polygon") continue;
    if (!hasCanonicalChainLogCoordinates(event)) continue;
    const key = buildCanonicalChainLogIdentity({
      txHash: event.txHash!,
      logIndex: event.logIndex!,
    });
    const list = index.get(key) ?? [];
    list.push(event);
    index.set(key, list);
  }
  return index;
}

function classifyClassDEvent(input: {
  event: WalletLedgerEvent;
  canonicalByPhysical: Map<string, WalletLedgerEvent[]>;
  persistableKeys: Set<string>;
}): TaxonomyCategory {
  const { event, canonicalByPhysical, persistableKeys } = input;
  if (event.source !== "polygon") {
    return "B_api_normalized_in_authoritative";
  }
  if (classifyChainEventIdentity(event) !== "unresolved_chain_log") {
    return "F_other";
  }
  if ((event.blockNumber ?? 0) <= 0 || !event.txHash) {
    return "D_synthetic_non_log";
  }

  const legacyNeutral = isLegacyTimestampBearingChainDedupeKey(event.dedupeKey)
    ? legacyTimestampNeutralDedupeKey(event.dedupeKey)
    : null;

  for (const canonical of canonicalByPhysical.values()) {
    for (const candidate of canonical) {
      if (economicMatchKey(candidate) === economicMatchKey(event)) {
        return "A_duplicate_legacy_representation";
      }
      if (
        legacyNeutral &&
        candidate.txHash?.toLowerCase() === event.txHash.toLowerCase() &&
        candidate.blockNumber === event.blockNumber &&
        candidate.type === event.type
      ) {
        return "A_duplicate_legacy_representation";
      }
    }
  }

  const mergeKey = assignChainEventDedupeKey(event).dedupeKey;
  if (persistableKeys.has(mergeKey)) {
    return "A_duplicate_legacy_representation";
  }

  return "E_genuinely_unresolved_physical";
}

function countClassD(events: WalletLedgerEvent[]): number {
  return filterChainAuthoritativeEvents(events).filter(
    (event) => classifyChainEventIdentity(event) === "unresolved_chain_log"
  ).length;
}

async function computeMetricsFromCombined(
  snapshot: WalletValidationSnapshot,
  combined: ReturnType<typeof buildLifecycleInput>
) {
  const gammaCache = new GammaResolutionCache();
  gammaCache.seedMany(snapshot.gammaCacheEntries);
  gammaCache.setFrozen(true);
  const { positions } = await buildPositionLifecycles(
    snapshot.wallet,
    combined,
    gammaCache
  );
  const mergeSplit = analyzeMergeSplitImpact(positions);
  const chainEvents = prepareAuthoritativeEventsForLifecycleMerge(
    filterChainAuthoritativeEvents(
      combined.filter((event) => event.source === "polygon")
    )
  );
  const unresolvedChainOrder = assessUnresolvedChainOrder(
    filterChainAuthoritativeEvents(
      combined.filter((event) => event.source === "polygon")
    )
  );
  const metrics = computeWalletLedgerMetrics({
    positions,
    identity: {
      confidence: "high",
      resolutionMethod: "proxy_wallet_direct",
      positionsOnlyMismatch: false,
    },
    activityTruncated: snapshot.activityTruncated,
    tradesTruncated: snapshot.tradesTruncated,
    rawEventCount: combined.length,
    deduplicatedEventCount: combined.length,
    gammaCoverage: {
      distinctMarkets: new Set(positions.map((p) => p.conditionId).filter(Boolean))
        .size,
      marketsFoundBefore: 1,
      marketsFoundAfter: 1,
      resolvedBefore: 0,
      resolvedAfter: 0,
      coverageBeforePct: 1,
      coverageAfterPct: 1,
      marketFoundCoverageAfterPct: 1,
    },
    mergeSplit,
    hasHistoryEvents: combined.length > 0,
    unresolvedChainOrderBlocksCredibility: unresolvedChainOrder.blocksCredibility,
    unresolvedChainEvents: unresolvedChainOrder.unresolvedChainEvents,
    unresolvedChainEventsInLifecycle:
      unresolvedChainOrder.unresolvedChainEventsInLifecycle,
    affectedPositionGroups: unresolvedChainOrder.affectedPositionGroups,
  });
  return {
    metrics,
    positions,
    combinedCount: combined.length,
    unresolvedChainOrder,
    chainEventsInLifecycle: chainEvents.length,
  };
}

async function auditWallet(wallet: string) {
  const normalized = wallet.toLowerCase();
  const snapshot = loadLatestSnapshot(wallet);
  if (!snapshot) {
    throw new Error(`missing validation snapshot for ${wallet}`);
  }

  const persisted = await loadPersistedWalletEvents(normalized);
  const persistedAuthoritative = filterChainAuthoritativeEvents(persisted);
  const persistedPersistable = filterPersistableAuthoritativeEvents(persisted);
  const auditAuthoritative = filterChainAuthoritativeEvents(
    snapshot.authoritativeEvents
  );

  const classDEvents = auditAuthoritative.filter(
    (event) => classifyChainEventIdentity(event) === "unresolved_chain_log"
  );
  const canonicalByPhysical = buildCanonicalIndex(persistableKeysFrom(persistedPersistable));
  const persistableKeys = new Set(
    persistedPersistable.map((event) => event.dedupeKey)
  );

  const taxonomyCounts: Record<TaxonomyCategory, number> = {
    A_duplicate_legacy_representation: 0,
    B_api_normalized_in_authoritative: 0,
    C_real_chain_logindex_lost: 0,
    D_synthetic_non_log: 0,
    E_genuinely_unresolved_physical: 0,
    F_other: 0,
  };

  let matchedToCanonicalPhysicalEvent = 0;
  let unmatchedClassD = 0;
  let ambiguousClassD = 0;

  for (const event of classDEvents) {
    const category = classifyClassDEvent({
      event,
      canonicalByPhysical,
      persistableKeys,
    });
    taxonomyCounts[category] += 1;
    if (category === "A_duplicate_legacy_representation") {
      matchedToCanonicalPhysicalEvent += 1;
    } else if (category === "E_genuinely_unresolved_physical") {
      unmatchedClassD += 1;
    } else if (category === "F_other") {
      ambiguousClassD += 1;
    }
  }

  const productionChain = prepareAuthoritativeEventsForLifecycleMerge(
    persistedAuthoritative
  );
  const productionCombined = buildLifecycleInput(
    snapshot.apiEvents,
    productionChain
  );

  const auditChainIncludingClassD = prepareAuthoritativeEventsForLifecycleMerge(
    auditAuthoritative
  );
  const auditCombinedIncludingClassD = buildLifecycleInput(
    snapshot.apiEvents,
    auditChainIncludingClassD
  );

  const auditChainExcludingClassD = prepareAuthoritativeEventsForLifecycleMerge(
    filterPersistableAuthoritativeEvents(snapshot.authoritativeEvents)
  );
  const auditCombinedExcludingClassD = buildLifecycleInput(
    snapshot.apiEvents,
    auditChainExcludingClassD
  );

  const productionReplay = await replayMetricsFromValidationSnapshot(snapshot, {
    chainEventsOverride: productionChain,
    frozen: true,
  });

  const productionMetrics = productionReplay.fullLedgerMetrics;
  const excludingClassDMetrics = (
    await computeMetricsFromCombined(
      snapshot,
      auditCombinedExcludingClassD
    )
  ).metrics;
  const includingClassDMetrics = (
    await computeMetricsFromCombined(
      snapshot,
      auditCombinedIncludingClassD
    )
  ).metrics;

  const db = getDb();
  const [metrics] = await db
    .select()
    .from(walletHistoricalMetrics)
    .where(
      and(
        eq(walletHistoricalMetrics.walletAddress, normalized),
        eq(walletHistoricalMetrics.metricVersion, WALLET_METRIC_VERSION)
      )
    )
    .limit(1);
  const [coverage] = await db
    .select()
    .from(walletHistoryCoverage)
    .where(eq(walletHistoryCoverage.walletAddress, normalized))
    .limit(1);

  const policyFromMetrics = (m: typeof productionMetrics) =>
    evaluateHistoricalPerformanceVerdict({
      indexedDataValidity: Boolean(m.credibilityMetricsValid),
      historyValidity: m.historyValidity,
      historyComplete: m.historyComplete,
      completedPositionCount: m.completedPositionCount,
      realizedRoi: m.portfolioRealizedRoi,
      profitablePositionRate: m.profitablePositionRate,
      metricVersion: WALLET_METRIC_VERSION,
    }).historicalPerformanceDecision;

  const classDInProductionLifecycle = productionCombined.filter(
    (event) =>
      event.source === "polygon" &&
      classifyChainEventIdentity(event) === "unresolved_chain_log"
  ).length;

  const logIndexTaxonomy = buildLogIndexTaxonomyReport({
    authoritativeEvents: auditAuthoritative,
  });

  return {
    wallet,
    snapshotRunId: snapshot.runId,
    db: {
      completedPositions: metrics?.completedPositions ?? null,
      realizedRoi: metrics?.realizedRoi ?? null,
      profitablePositionRate: metrics?.profitablePositionRate ?? null,
      historyValidity: metrics?.historyValidity ?? null,
      credibilityMetricsValid: metrics?.credibilityMetricsValid ?? null,
      historyIncompleteReasons: metrics?.historyIncompleteReasons ?? [],
      identityComplete: coverage?.identityComplete ?? null,
      eventHistoryComplete: coverage?.eventHistoryComplete ?? null,
    },
    inventory: {
      auditAuthoritativeCount: auditAuthoritative.length,
      auditClassD: classDEvents.length,
      auditPersistable: filterPersistableAuthoritativeEvents(
        snapshot.authoritativeEvents
      ).length,
      persistedAuthoritativeCount: persistedAuthoritative.length,
      persistedClassD: countClassD(persisted),
      logIndexMissing: logIndexTaxonomy.missingLogIndex,
      logIndexTaxonomy: logIndexTaxonomy.countsByCategory,
    },
    taxonomyCounts,
    duplicateCoverage: {
      classDTotal: classDEvents.length,
      matchedToCanonicalPhysicalEvent,
      unmatchedClassD,
      ambiguousClassD,
    },
    lifecycleParticipation: {
      canonicalChainEventsEnteringLifecycle: productionChain.length,
      classDEnteringLifecycle: classDInProductionLifecycle,
      classDExcludedBeforeLifecycle:
        classDEvents.length - classDInProductionLifecycle,
      apiEventsEnteringLifecycle: snapshot.apiEvents.length,
      finalLifecycleInputCount: productionCombined.length,
      auditIncludingClassDLifecycleCount: auditCombinedIncludingClassD.length,
      productionVsAuditIncludingClassDDelta:
        auditCombinedIncludingClassD.length - productionCombined.length,
    },
    metricSensitivity: {
      A_production_persisted: summarizeMetrics(
        productionMetrics,
        productionCombined.length,
        policyFromMetrics
      ),
      B_audit_excluding_classD: summarizeMetrics(
        excludingClassDMetrics,
        auditCombinedExcludingClassD.length,
        policyFromMetrics
      ),
      C_audit_including_classD: summarizeMetrics(
        includingClassDMetrics,
        auditCombinedIncludingClassD.length,
        policyFromMetrics
      ),
    },
    sampleClassD: classDEvents.slice(0, 3).map((event) => ({
      dedupeKey: event.dedupeKey,
      txHash: event.txHash ?? null,
      blockNumber: event.blockNumber ?? null,
      logIndex: event.logIndex ?? null,
      type: event.type,
      shares: event.shares ?? null,
      cashUsd: event.cashUsd ?? null,
      persistable: isPersistableAuthoritativeEvent(event),
      inPersistedDb: persisted.some((row) => row.dedupeKey === event.dedupeKey),
    })),
  };
}

function persistableKeysFrom(events: WalletLedgerEvent[]): Map<string, WalletLedgerEvent[]> {
  return buildCanonicalIndex(events);
}

function summarizeMetrics(
  metrics: import("@/lib/walletLedger/types").WalletLedgerMetrics,
  lifecycleInputCount: number,
  policyFromMetrics: (
    m: import("@/lib/walletLedger/types").WalletLedgerMetrics
  ) => string
) {
  return {
    completedPositions: metrics.completedPositionCount,
    roi: metrics.portfolioRealizedRoi,
    profitablePositionRate: metrics.profitablePositionRate,
    historyValidity: metrics.historyValidity,
    credibilityMetricsValid: metrics.credibilityMetricsValid,
    policyA: policyFromMetrics(metrics),
    lifecycleInputCount,
  };
}

async function main(): Promise<void> {
  if (!isDatabaseEnabled()) {
    console.error("DATABASE_URL not configured");
    process.exit(1);
  }

  const wallets = [];
  for (const wallet of WALLETS) {
    wallets.push(await auditWallet(wallet));
  }

  console.log(
    JSON.stringify(
      {
        mode: "policy_a_class_d_safety_audit",
        generatedAt: new Date().toISOString(),
        wallets,
        cohortReportingNote: {
          useMeasuredPreBatch: { total: 77, pass: 11, fail: 27, unknown: 39 },
          useMeasuredPostBatch: { total: 77, pass: 13, fail: 30, unknown: 34 },
          doNotUseBaseline88ForBatch2Impact: true,
        },
      },
      null,
      2
    )
  );
}

void main().catch((error) => {
  console.error("[policy-a-class-d-safety-audit] failed:", error);
  process.exit(1);
});
