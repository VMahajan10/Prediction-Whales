#!/usr/bin/env tsx
/**
 * Authoritative baseline repair for the four Policy A pilot wallets.
 * Does not hydrate wallets outside the pilot set.
 */
import "../tests/preload-env";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/crossmarket/store/db";
import { walletHistoricalMetrics } from "@/lib/crossmarket/store/schema";
import {
  fetchActivityHistory,
  fetchTradeHistory,
} from "@/lib/walletLedger/fetchers";
import { evaluateHistoricalPerformanceVerdict } from "@/lib/walletLedger/indexed/historicalPerformanceVerdict";
import { readPersistentGammaCache } from "@/lib/walletLedger/indexed/gammaCacheStore";
import { WALLET_METRIC_VERSION } from "@/lib/walletLedger/indexed/metricVersion";
import { runIndexedWalletAudit } from "@/lib/walletLedger/indexed/pipeline";
import {
  assessAuthoritativeBaselineCompleteness,
  filterChainAuthoritativeEvents,
  loadPersistedAuthoritativeDedupeKeys,
  selectLegacyBlockIncrementalCandidates,
} from "@/lib/walletLedger/indexed/store/authoritativePersistence";
import { countPersistedEventMetadataCoverage } from "@/lib/walletLedger/indexed/store/eventMetadataEnrichment";
import {
  countWalletLedgerEvents,
  loadLastIndexedBlock,
  loadPersistedWalletEvents,
  persistIndexedWalletAudit,
} from "@/lib/walletLedger/indexed/store/persistWalletHistory";
import {
  buildValidationSnapshotFromAudit,
  compareReplayToSnapshot,
  replayMetricsFromValidationSnapshot,
  saveValidationSnapshot,
} from "@/lib/walletLedger/indexed/store/validationSnapshot";
import {
  deduplicateLedgerEvents,
  normalizeActivityRows,
  normalizeTradeRows,
} from "@/lib/walletLedger/normalize";
const PILOT_WALLETS = [
  { wallet: "0x4f29e103339919c4baaea2a60195cf1c8bb27a7e", role: "source_specific" },
  { wallet: "0xe9076a87c5ed90ef16e6fe6529c943baeca0cff6", role: "adaptive_earlier" },
  { wallet: "0x1ff3d3fdef2558f3eb4aabdd7011a0245df8eb39", role: "regression_control" },
  { wallet: "0xde7be6d489bce070a959e0cb813128ae659b5f4b", role: "truncation_case" },
] as const;

const ONLY_WALLET = process.env.ONLY_WALLET?.toLowerCase();

async function auditRootCause(wallet: string, audit: Awaited<ReturnType<typeof runIndexedWalletAudit>>) {
  const authoritative = filterChainAuthoritativeEvents(
    audit.authoritativeIndexedEvents ?? []
  );
  const delta = audit.indexedEvents ?? [];
  const persistedBefore = await countWalletLedgerEvents(wallet);
  const persistedKeys = await loadPersistedAuthoritativeDedupeKeys(wallet);
  const lastIndexedBlock = await loadLastIndexedBlock(wallet);
  const legacyCandidates = selectLegacyBlockIncrementalCandidates(delta, {
    lastIndexedBlock,
    throughBlock: audit.throughBlock ?? null,
  });
  const assessment = assessAuthoritativeBaselineCompleteness({
    authoritativeEvents: authoritative,
    persistedDedupeKeys: persistedKeys,
    persistedEventsBefore: persistedBefore,
    lastIndexedBlock,
  });
  return {
    authoritativeEventsPresentedToPersistence: authoritative.length,
    deltaEventsInAudit: delta.length,
    legacyIncrementalCandidates: legacyCandidates.length,
    existingDbEvents: persistedBefore,
    missingAuthoritativeEvents: assessment.authoritativeEventsMissingBefore,
    lastIndexedBlock,
    throughBlock: audit.throughBlock ?? null,
    selectionConditions: [
      "legacy path used audit.indexedEvents (delta only), not full authoritative set",
      "legacy path filtered blockNumber > lastIndexedBlock",
      "lastIndexedBlock treated as if historical DB baseline were complete",
    ],
    baselineAssessment: assessment,
  };
}

async function repairWallet(pilot: (typeof PILOT_WALLETS)[number]) {
  const wallet = pilot.wallet.toLowerCase();
  const started = Date.now();
  console.error(`\n[repair] === ${pilot.role} ${wallet} ===`);

  const audit = await runIndexedWalletAudit({
    label: `authoritative-baseline-repair-${pilot.role}`,
    wallet,
    providerId: "etherscan_v2",
    fullHistory: true,
    resumeCheckpoint: true,
    allowEarlierThanIncremental: true,
  });

  const rootCause = await auditRootCause(wallet, audit);
  console.error(`[repair] root-cause ${wallet}`, JSON.stringify(rootCause, null, 2));

  const [activity, trades] = await Promise.all([
    fetchActivityHistory(wallet, { interPageDelayMs: 25 }),
    fetchTradeHistory(wallet, { interPageDelayMs: 25 }),
  ]);
  const apiEvents = deduplicateLedgerEvents(
    normalizeActivityRows(activity.rows, wallet),
    normalizeTradeRows(trades.rows, wallet)
  );
  const gammaCacheEntries =
    audit.gammaCacheEntries ?? [...readPersistentGammaCache().entries()];
  const snapshot = buildValidationSnapshotFromAudit(audit, {
    apiEvents,
    gammaCacheEntries,
  });
  const snapshotPath = await saveValidationSnapshot(snapshot);
  console.error(`[repair] snapshot saved ${snapshotPath}`);

  const metadataBefore = await countPersistedEventMetadataCoverage(wallet);
  const persistResult = await persistIndexedWalletAudit(audit);
  const metadataAfter = await countPersistedEventMetadataCoverage(wallet);
  const persistedEvents = await loadPersistedWalletEvents(wallet);
  const replayAudit = await replayMetricsFromValidationSnapshot(snapshot, {
    frozen: true,
  });
  const replayPersisted = await replayMetricsFromValidationSnapshot(snapshot, {
    chainEventsOverride: persistedEvents,
    frozen: true,
  });
  const comparison = compareReplayToSnapshot(snapshot, replayPersisted);

  const db = getDb();
  const [durable] = await db
    .select()
    .from(walletHistoricalMetrics)
    .where(
      and(
        eq(walletHistoricalMetrics.walletAddress, wallet),
        eq(walletHistoricalMetrics.metricVersion, WALLET_METRIC_VERSION)
      )
    )
    .limit(1);

  return {
    wallet,
    role: pilot.role,
    elapsedSeconds: Math.round((Date.now() - started) / 1000),
    rootCause,
    snapshotPath,
    authoritativeCount: snapshot.authoritativeEventCount,
    persistedBefore: persistResult.authoritativePersistDiagnostics.persistedEventsBefore,
    insertedMissing:
      persistResult.authoritativePersistDiagnostics.authoritativeEventsInserted,
    persistedAfter: persistResult.authoritativePersistDiagnostics.persistedEventsAfter,
    missingAfter:
      persistResult.authoritativePersistDiagnostics.authoritativeEventsMissingAfter,
    baselineComplete:
      persistResult.authoritativePersistDiagnostics.baselineComplete,
    logIndex: {
      authoritativeWithLogIndex:
        persistResult.logIndexCompleteness.authoritativeWithLogIndex,
      persistedWithLogIndexBefore: metadataBefore.withLogIndex,
      logIndexBackfills: persistResult.metadataEnrichment.logIndexBackfills,
      persistedWithLogIndexAfter: metadataAfter.withLogIndex,
      persistedMissingLogIndexAfter: metadataAfter.missingLogIndex,
      report: persistResult.logIndexCompleteness,
    },
    auditMetrics: snapshot.auditMetrics,
    replayFromSnapshotAuthoritative: replayAudit.metrics,
    replayFromPersistedChain: replayPersisted.metrics,
    durableMetrics: durable
      ? {
          completedPositions: durable.completedPositions,
          realizedRoi: durable.realizedRoi,
          profitablePositionRate: durable.profitablePositionRate,
          policyAVerdict: evaluateHistoricalPerformanceVerdict({
            indexedDataValidity: durable.credibilityMetricsValid,
            historyValidity: durable.historyValidity,
            completedPositionCount: durable.completedPositions,
            realizedRoi: durable.realizedRoi,
            profitablePositionRate: durable.profitablePositionRate,
            metricVersion: WALLET_METRIC_VERSION,
          }).historicalPerformanceDecision,
        }
      : null,
    exactReplay: comparison,
    authoritativePersistDiagnostics:
      persistResult.authoritativePersistDiagnostics,
  };
}

async function main() {
  const targets = ONLY_WALLET
    ? PILOT_WALLETS.filter((pilot) => pilot.wallet === ONLY_WALLET)
    : PILOT_WALLETS;

  if (targets.length === 0) {
    throw new Error(`Wallet not in pilot set: ${ONLY_WALLET}`);
  }

  const results = [];
  for (const pilot of targets) {
    results.push(await repairWallet(pilot));
    const last = results.at(-1)!;
    if (!last.baselineComplete || !last.exactReplay.exactMatch) {
      console.log(
        JSON.stringify(
          {
            mode: "authoritative_baseline_repair_pilot",
            stoppedEarly: true,
            recommendation: "FIX_REQUIRED",
            results,
          },
          null,
          2
        )
      );
      process.exit(1);
    }
  }

  const allExact = results.every((result) => result.exactReplay.exactMatch);
  const allBaseline = results.every((result) => result.baselineComplete);
  console.log(
    JSON.stringify(
      {
        mode: "authoritative_baseline_repair_pilot",
        walletsProcessed: results.length,
        allBaselineComplete: allBaseline,
        allExactReplay: allExact,
        recommendation:
          allExact && allBaseline
            ? "READY_FOR_BOUNDED_COHORT_HYDRATION"
            : "FIX_REQUIRED",
        results,
      },
      null,
      2
    )
  );
}

void main().catch((error) => {
  console.error("[repair-authoritative-baseline-pilot] failed:", error);
  process.exit(1);
});
