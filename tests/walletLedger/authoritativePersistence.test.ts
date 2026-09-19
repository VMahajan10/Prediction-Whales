import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  assignChainEventDedupeKey,
  authoritativeEventMergeKey,
} from "@/lib/walletLedger/canonicalChainIdentity";
import type { WalletLedgerEvent } from "@/lib/walletLedger/types";

function chainEvent(
  keySeed: string,
  blockNumber: number,
  logIndex?: number
): WalletLedgerEvent {
  return assignChainEventDedupeKey({
    wallet: "0xwallet",
    conditionId: "cond",
    asset: `asset-${keySeed}`,
    timestamp: 1_700_000_000,
    type: "BUY",
    dedupeKey: "",
    source: "polygon",
    blockNumber,
    logIndex: logIndex ?? keySeed.length,
    txHash: `0xtx${keySeed}`,
  });
}

function apiEvent(dedupeKey: string): WalletLedgerEvent {
  return {
    wallet: "0xwallet",
    conditionId: "cond",
    asset: "asset",
    timestamp: 1_700_000_000,
    type: "BUY",
    dedupeKey,
    source: "activity",
  };
}

describe("authoritativePersistence", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("A: baseline repair inserts remaining authoritative identities", async () => {
    const {
      assessAuthoritativeBaselineCompleteness,
      resolveAuthoritativePersistenceMode,
      selectAuthoritativePersistenceCandidates,
    } = await import("@/lib/walletLedger/indexed/store/authoritativePersistence");

    const authoritative = Array.from({ length: 1_000 }, (_, i) =>
      chainEvent(`auth-${i}`, 1_000 + i, i)
    );
    const persisted = new Set(
      authoritative
        .slice(0, 100)
        .map((event) => authoritativeEventMergeKey(event))
    );
    const assessment = assessAuthoritativeBaselineCompleteness({
      authoritativeEvents: authoritative,
      persistedDedupeKeys: persisted,
      persistedEventsBefore: 100,
      lastIndexedBlock: 9_999,
    });
    expect(assessment.authoritativeEventsMissingBefore).toBe(900);
    expect(assessment.baselineComplete).toBe(false);
    expect(resolveAuthoritativePersistenceMode(assessment)).toBe(
      "baseline_repair"
    );

    const candidates = selectAuthoritativePersistenceCandidates({
      mode: "baseline_repair",
      authoritativeEvents: authoritative,
      deltaEvents: authoritative.slice(900),
      persistedDedupeKeys: persisted,
    });
    expect(candidates).toHaveLength(900);
    expect(candidates[0]?.dedupeKey).toBe(
      authoritativeEventMergeKey(authoritative[100]!)
    );
  });

  it("B: rerun same authoritative set yields incremental mode with 0 inserts", async () => {
    const {
      assessAuthoritativeBaselineCompleteness,
      resolveAuthoritativePersistenceMode,
      selectAuthoritativePersistenceCandidates,
    } = await import("@/lib/walletLedger/indexed/store/authoritativePersistence");

    const authoritative = Array.from({ length: 50 }, (_, i) =>
      chainEvent(`auth-${i}`, 500 + i, i)
    );
    const persisted = new Set(
      authoritative.map((event) => authoritativeEventMergeKey(event))
    );
    const assessment = assessAuthoritativeBaselineCompleteness({
      authoritativeEvents: authoritative,
      persistedDedupeKeys: persisted,
      persistedEventsBefore: 50,
      lastIndexedBlock: 10_000,
    });
    expect(assessment.baselineComplete).toBe(true);
    expect(resolveAuthoritativePersistenceMode(assessment)).toBe("incremental");
    const candidates = selectAuthoritativePersistenceCandidates({
      mode: "incremental",
      authoritativeEvents: authoritative,
      deltaEvents: authoritative,
      persistedDedupeKeys: persisted,
    });
    expect(candidates).toHaveLength(0);
  });

  it("C: high lastIndexedBlock with sparse historical rows enters baseline repair", async () => {
    const {
      assessAuthoritativeBaselineCompleteness,
      resolveAuthoritativePersistenceMode,
      selectAuthoritativePersistenceCandidates,
      selectLegacyBlockIncrementalCandidates,
    } = await import("@/lib/walletLedger/indexed/store/authoritativePersistence");

    const authoritative = [
      chainEvent("old-1", 1_000, 1),
      chainEvent("old-2", 1_500, 2),
      chainEvent("new-1", 9_500, 3),
    ];
    const persisted = new Set([
      authoritativeEventMergeKey(authoritative[2]!),
    ]);
    const assessment = assessAuthoritativeBaselineCompleteness({
      authoritativeEvents: authoritative,
      persistedDedupeKeys: persisted,
      persistedEventsBefore: 1,
      lastIndexedBlock: 9_000,
    });
    expect(assessment.baselineComplete).toBe(false);
    expect(resolveAuthoritativePersistenceMode(assessment)).toBe(
      "baseline_repair"
    );
    const repaired = selectAuthoritativePersistenceCandidates({
      mode: "baseline_repair",
      authoritativeEvents: authoritative,
      deltaEvents: [authoritative[2]!],
      persistedDedupeKeys: persisted,
    });
    expect(repaired.map((event) => event.dedupeKey)).toEqual([
      authoritativeEventMergeKey(authoritative[0]!),
      authoritativeEventMergeKey(authoritative[1]!),
    ]);

    const legacyOnly = selectLegacyBlockIncrementalCandidates(authoritative, {
      lastIndexedBlock: 9_000,
      throughBlock: 9_600,
    });
    expect(legacyOnly.map((event) => event.dedupeKey)).toEqual([
      authoritative[2]!.dedupeKey,
    ]);
  });

  it("D: does not include API-only events in authoritative persistence candidates", async () => {
    const { selectAuthoritativePersistenceCandidates } = await import(
      "@/lib/walletLedger/indexed/store/authoritativePersistence"
    );
    const authoritative = [chainEvent("chain-1", 100, 1), apiEvent("api-1")];
    const candidates = selectAuthoritativePersistenceCandidates({
      mode: "baseline_repair",
      authoritativeEvents: authoritative,
      deltaEvents: authoritative,
      persistedDedupeKeys: new Set(),
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.dedupeKey).toBe(
      authoritativeEventMergeKey(authoritative[0]!)
    );
  });

  it("E: frozen replay inputs reproduce identical lifecycle metrics", async () => {
    const {
      buildValidationSnapshotFromAudit,
      compareReplayToSnapshot,
      replayMetricsFromValidationSnapshot,
    } = await import("@/lib/walletLedger/indexed/store/validationSnapshot");

    const authoritative: WalletLedgerEvent[] = [];
    const apiEvents: WalletLedgerEvent[] = [];
    const audit = {
      wallet: "0xwallet",
      coverage: {
        oldestActivityTimestamp: 1_700_000_000,
        oldestTradesTimestamp: 1_699_000_000,
      },
      sourceTruncationImmunity: {
        activityTruncated: false,
        tradesTruncated: false,
      },
      authoritativeIndexedEvents: authoritative,
      indexedLedgerMetrics: {
        completedPositionCount: 0,
        portfolioRealizedRoi: 0,
        profitablePositionRate: 0,
        historyValidity: "partial-but-metrics-safe",
        credibilityMetricsValid: true,
      },
      indexedLifecyclePositions: [],
    } as import("@/lib/walletLedger/indexed/types").IndexedAuditWalletResult;

    const snapshot = buildValidationSnapshotFromAudit(audit, {
      apiEvents,
      gammaCacheEntries: [],
      runId: "test-run",
    });
    const replay = await replayMetricsFromValidationSnapshot(snapshot);
    const comparison = compareReplayToSnapshot(snapshot, replay);
    expect(comparison.exactMatch).toBe(true);
    expect(comparison.completedDelta).toBe(0);
    expect(comparison.policyAMatch).toBe(true);
  });

  it("F: live API changes do not affect same-run frozen snapshot replay", async () => {
    const {
      buildValidationSnapshotFromAudit,
      replayMetricsFromValidationSnapshot,
    } = await import("@/lib/walletLedger/indexed/store/validationSnapshot");

    const authoritative = [chainEvent("chain-1", 200, 0)];
    const frozenApi = [apiEvent("api-frozen")];
    const audit = {
      wallet: "0xwallet",
      coverage: {
        oldestActivityTimestamp: 1_700_000_000,
        oldestTradesTimestamp: 1_699_000_000,
      },
      sourceTruncationImmunity: {
        activityTruncated: false,
        tradesTruncated: false,
      },
      authoritativeIndexedEvents: authoritative,
      indexedLedgerMetrics: {
        completedPositionCount: 0,
        portfolioRealizedRoi: 0,
        profitablePositionRate: 0,
        historyValidity: "partial-but-metrics-safe",
        credibilityMetricsValid: true,
      },
      indexedLifecyclePositions: [],
    } as import("@/lib/walletLedger/indexed/types").IndexedAuditWalletResult;

    const snapshot = buildValidationSnapshotFromAudit(audit, {
      apiEvents: frozenApi,
      gammaCacheEntries: [],
      runId: "frozen",
    });
    const first = await replayMetricsFromValidationSnapshot(snapshot);
    snapshot.apiEvents = [...frozenApi, apiEvent("api-live-after-persist")];
    expect(snapshot.replayInputHash).not.toBe(
      createHash("sha256")
        .update(
          JSON.stringify({
            apiKeys: snapshot.apiEvents.map((event) => event.dedupeKey).sort(),
            authHash: snapshot.authoritativeEventIdentityHash,
            activityTruncated: false,
            tradesTruncated: false,
            gammaCacheEntries: [],
          })
        )
        .digest("hex")
    );
    const frozenReplay = await replayMetricsFromValidationSnapshot({
      ...snapshot,
      apiEvents: frozenApi,
    });
    expect(frozenReplay.metrics).toEqual(first.metrics);
  });
});
