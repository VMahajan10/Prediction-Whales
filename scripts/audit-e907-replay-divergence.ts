#!/usr/bin/env tsx
/**
 * e907 exact-replay divergence audit (read-only).
 */
import "../tests/preload-env";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  fetchActivityHistory,
  fetchTradeHistory,
} from "@/lib/walletLedger/fetchers";
import { runIndexedWalletAudit } from "@/lib/walletLedger/indexed/pipeline";
import {
  buildLifecycleInput,
  buildValidationSnapshotFromAudit,
  hashLifecycleInput,
  loadValidationSnapshot,
  prepareAuthoritativeEventsForLifecycleMerge,
  replayMetricsFromValidationSnapshot,
  verifyValidationSnapshotReplay,
} from "@/lib/walletLedger/indexed/store/validationSnapshot";
import {
  deduplicateLedgerEvents,
  normalizeActivityRows,
  normalizeTradeRows,
} from "@/lib/walletLedger/normalize";
import { hashAuthoritativeEventIdentities } from "@/lib/walletLedger/indexed/store/authoritativePersistence";
import { mergeApiAndChainEvents } from "@/lib/walletLedger/onchain/normalize";

const WALLET = "0xe9076a87c5ed90ef16e6fe6529c943baeca0cff6";
const SNAPSHOT_PATH =
  process.env.SNAPSHOT_PATH ??
  path.join(
    process.cwd(),
    ".cache",
    "wallet-validation-snapshots",
    "0xe9076a87c5ed90ef16e6fe6529c943baeca0cff6-0xe9076a87c5ed90ef16e6fe6529c943baeca0cff6-mu1loay7.json"
  );

function hashApiKeys(events: { dedupeKey: string }[]): string {
  return createHash("sha256")
    .update(events.map((event) => event.dedupeKey).sort().join("\n"))
    .digest("hex");
}

function classifyEvent(event: {
  source: string;
  dedupeKey: string;
}): string {
  if (event.source === "polygon") return "authoritative_chain_event";
  if (event.dedupeKey.includes("|activity|")) return "api_activity_event";
  if (event.dedupeKey.includes("|trade|")) return "api_trades_event";
  return "api_event";
}

function diffLifecycleInputs(
  auditEvents: ReturnType<typeof buildLifecycleInput>,
  replayEvents: ReturnType<typeof buildLifecycleInput>
) {
  const auditMap = new Map(
    auditEvents.map((event) => [event.dedupeKey, event])
  );
  const replayMap = new Map(
    replayEvents.map((event) => [event.dedupeKey, event])
  );
  const onlyAudit = [...auditMap.keys()].filter((key) => !replayMap.has(key));
  const onlyReplay = [...replayMap.keys()].filter((key) => !auditMap.has(key));
  const byClass: Record<
    string,
    { onlyAudit: number; onlyReplay: number; samples: string[] }
  > = {};
  for (const key of onlyAudit) {
    const event = auditMap.get(key)!;
    const className = classifyEvent(event);
    const bucket = byClass[className] ?? {
      onlyAudit: 0,
      onlyReplay: 0,
      samples: [],
    };
    bucket.onlyAudit += 1;
    if (bucket.samples.length < 20) bucket.samples.push(key);
    byClass[className] = bucket;
  }
  for (const key of onlyReplay) {
    const event = replayMap.get(key)!;
    const className = classifyEvent(event);
    const bucket = byClass[className] ?? {
      onlyAudit: 0,
      onlyReplay: 0,
      samples: [],
    };
    bucket.onlyReplay += 1;
    if (bucket.samples.length < 20) bucket.samples.push(key);
    byClass[className] = bucket;
  }
  const earliest = [...onlyAudit, ...onlyReplay]
    .map((key) => auditMap.get(key) ?? replayMap.get(key)!)
    .sort(
      (a, b) =>
        (a.blockNumber ?? a.timestamp) - (b.blockNumber ?? b.timestamp) ||
        a.dedupeKey.localeCompare(b.dedupeKey)
    )[0];
  return {
    onlyAuditCount: onlyAudit.length,
    onlyReplayCount: onlyReplay.length,
    byClass,
    earliestDivergence: earliest
      ? {
          dedupeKey: earliest.dedupeKey,
          source: earliest.source,
          blockNumber: earliest.blockNumber ?? null,
          timestamp: earliest.timestamp,
          conditionId: earliest.conditionId,
          asset: earliest.asset,
          type: earliest.type,
        }
      : null,
  };
}

async function main() {
  const snapshot = await loadValidationSnapshot(SNAPSHOT_PATH);
  const audit = await runIndexedWalletAudit({
    label: "e907-divergence-audit",
    wallet: WALLET,
    providerId: "etherscan_v2",
    fullHistory: true,
    resumeCheckpoint: true,
    allowEarlierThanIncremental: true,
  });

  const [refetchActivity, refetchTrades] = await Promise.all([
    fetchActivityHistory(WALLET, { interPageDelayMs: 25 }),
    fetchTradeHistory(WALLET, { interPageDelayMs: 25 }),
  ]);
  const refetchedApiEvents = deduplicateLedgerEvents(
    normalizeActivityRows(refetchActivity.rows, WALLET),
    normalizeTradeRows(refetchTrades.rows, WALLET)
  );

  const auditApiEvents = audit.apiEvents ?? [];
  const auditAuthoritative = prepareAuthoritativeEventsForLifecycleMerge(
    audit.authoritativeIndexedEvents ?? []
  );
  const snapshotAuthoritative = prepareAuthoritativeEventsForLifecycleMerge(
    snapshot.authoritativeEvents
  );
  const auditLifecycle = buildLifecycleInput(auditApiEvents, auditAuthoritative);
  const snapshotLifecycle = buildLifecycleInput(
    snapshot.apiEvents,
    snapshotAuthoritative
  );
  const refetchLifecycle = buildLifecycleInput(
    refetchedApiEvents,
    auditAuthoritative
  );

  const auditLifecycleHash = hashLifecycleInput(auditLifecycle);
  const snapshotLifecycleHash = hashLifecycleInput(snapshotLifecycle);
  const refetchLifecycleHash = hashLifecycleInput(refetchLifecycle);

  const auditMerge = mergeApiAndChainEvents(auditApiEvents, auditAuthoritative);
  const snapshotMerge = mergeApiAndChainEvents(
    snapshot.apiEvents,
    snapshotAuthoritative
  );
  const duplicateCollapsedAudit =
    auditApiEvents.length +
    auditAuthoritative.length -
    auditMerge.length;
  const duplicateCollapsedSnapshot =
    snapshot.apiEvents.length +
    snapshotAuthoritative.length -
    snapshotMerge.length;

  let replayResult: Awaited<
    ReturnType<typeof verifyValidationSnapshotReplay>
  > | null = null;
  try {
    replayResult = await verifyValidationSnapshotReplay(snapshot);
  } catch (error) {
    replayResult = {
      inputMatch: false,
      metricsMatch: false,
      replay: {
        metrics: snapshot.auditMetrics,
        positions: [],
        combinedEventCount: snapshot.combinedEventCount,
        replayLifecycleInputHash: snapshotLifecycleHash.hash,
        replayLifecycleInputCount: snapshotLifecycleHash.count,
        replayInputHash: "",
        inputMismatch: true,
        inputMismatchReason: String(error),
      },
      comparison: {
        exactMatch: false,
        completedDelta: 0,
        roiDelta: 0,
        profitableRateDelta: 0,
        policyAMatch: false,
        lifecycleEpisodeMatch: false,
        lifecycleEpisodeKeysMatch: false,
      },
    };
  }

  const fixedSnapshot = buildValidationSnapshotFromAudit(audit, {
    apiEvents: auditApiEvents,
    gammaCacheEntries: audit.gammaCacheEntries,
  });
  const fixedReplay = await replayMetricsFromValidationSnapshot(fixedSnapshot, {
    frozen: true,
  });

  const windowMismatch =
    snapshot.throughBlock != null &&
    audit.throughBlock != null &&
    snapshot.throughBlock !== audit.throughBlock;

  const result = {
    mode: "e907_replay_divergence_audit",
    wallet: WALLET,
    snapshotPath: SNAPSHOT_PATH,
    window: {
      snapshotThroughBlock: snapshot.throughBlock ?? null,
      auditThroughBlock: audit.throughBlock ?? null,
      snapshotScanFromBlock: snapshot.scanFromBlock ?? null,
      auditScanFromBlock: audit.scanFromBlock ?? null,
      windowMismatch,
      diagnosis: windowMismatch ? "SNAPSHOT_WINDOW_MISMATCH" : "WINDOW_OK",
    },
    header: {
      metricVersion: snapshot.metricVersion,
      chainId: snapshot.chainId ?? "137",
      authoritativeCanonicalIdentityCount: snapshot.authoritativeEventCount,
      authoritativeCanonicalIdentityHash: snapshot.authoritativeEventIdentityHash,
      auditAuthoritativeCount: auditAuthoritative.length,
      auditAuthoritativeHash: hashAuthoritativeEventIdentities(auditAuthoritative),
    },
    lifecycleInputHashes: {
      auditLifecycleInputCount: auditLifecycleHash.count,
      auditLifecycleInputHash: auditLifecycleHash.hash,
      snapshotLifecycleInputCount: snapshotLifecycleHash.count,
      snapshotLifecycleInputHash: snapshotLifecycleHash.hash,
      replayLifecycleInputCount: replayResult.replay.replayLifecycleInputCount,
      replayLifecycleInputHash: replayResult.replay.replayLifecycleInputHash,
      refetchLifecycleInputCount: refetchLifecycleHash.count,
      refetchLifecycleInputHash: refetchLifecycleHash.hash,
      fixedSnapshotLifecycleInputHash: fixedSnapshot.auditLifecycleInputHash,
      fixedReplayLifecycleInputHash: fixedReplay.replayLifecycleInputHash,
      lifecycleInputMatch:
        auditLifecycleHash.hash === snapshotLifecycleHash.hash,
    },
    apiExactness: {
      auditApiCount: auditApiEvents.length,
      auditApiHash: hashApiKeys(auditApiEvents),
      snapshotApiCount: snapshot.apiEvents.length,
      snapshotApiHash: hashApiKeys(snapshot.apiEvents),
      refetchApiCount: refetchedApiEvents.length,
      refetchApiHash: hashApiKeys(refetchedApiEvents),
      auditMatchesSnapshot:
        hashApiKeys(auditApiEvents) === hashApiKeys(snapshot.apiEvents),
      snapshotMatchesRefetch:
        hashApiKeys(snapshot.apiEvents) === hashApiKeys(refetchedApiEvents),
      auditMatchesRefetch:
        hashApiKeys(auditApiEvents) === hashApiKeys(refetchedApiEvents),
    },
    gamma: {
      snapshotGammaCount: snapshot.gammaCacheEntries.length,
      auditGammaCount: audit.gammaCacheEntries?.length ?? 0,
      snapshotGammaHash: createHash("sha256")
        .update(JSON.stringify(snapshot.gammaCacheEntries))
        .digest("hex"),
      auditGammaHash: createHash("sha256")
        .update(JSON.stringify(audit.gammaCacheEntries ?? []))
        .digest("hex"),
    },
    mergeParity: {
      auditApiCount: auditApiEvents.length,
      auditAuthoritativeCount: auditAuthoritative.length,
      duplicateCollapsedAudit,
      auditCombinedCount: auditMerge.length,
      snapshotApiCount: snapshot.apiEvents.length,
      snapshotAuthoritativeCount: snapshotAuthoritative.length,
      duplicateCollapsedSnapshot,
      snapshotCombinedCount: snapshotMerge.length,
    },
    eventSetDiff: diffLifecycleInputs(auditLifecycle, snapshotLifecycle),
    metrics: {
      snapshotAuditCompleted: snapshot.auditMetrics.completedPositions,
      replayCompleted: replayResult.replay.metrics.completedPositions,
      completedDelta: replayResult.comparison.completedDelta,
      auditPipelineCompleted: audit.indexedCompletedPositions,
      fixedSnapshotCompleted: fixedSnapshot.auditMetrics.completedPositions,
      fixedReplayCompleted: fixedReplay.metrics.completedPositions,
      fixedReplayDelta:
        fixedReplay.metrics.completedPositions -
        fixedSnapshot.auditMetrics.completedPositions,
    },
    rootCause:
      hashApiKeys(auditApiEvents) !== hashApiKeys(snapshot.apiEvents)
        ? "SNAPSHOT_STORED_REFETCHED_API_EVENTS_INSTEAD_OF_AUDIT_API_EVENTS"
        : auditLifecycleHash.hash !== snapshotLifecycleHash.hash
          ? "LIFECYCLE_INPUT_DIVERGENCE"
          : replayResult.comparison.completedDelta !== 0
            ? "LIFECYCLE_OUTPUT_DIVERGENCE_WITH_IDENTICAL_INPUTS"
            : "NONE",
    fix:
      "Use audit.apiEvents from runIndexedWalletAudit when building snapshots; do not refetch API. Enforce auditLifecycleInputHash parity before metric comparison.",
    recommendation:
      fixedReplay.metrics.completedPositions ===
        fixedSnapshot.auditMetrics.completedPositions &&
      auditLifecycleHash.hash === fixedReplay.replayLifecycleInputHash
        ? "REBUILD_E907_SNAPSHOT_WITH_AUDIT_API_EVENTS"
        : "FIX_REQUIRED",
  };

  console.log(JSON.stringify(result, null, 2));
}

void main().catch((error) => {
  console.error("[audit-e907-replay-divergence] failed:", error);
  process.exit(1);
});
