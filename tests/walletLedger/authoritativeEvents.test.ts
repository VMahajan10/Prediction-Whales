import { describe, expect, it } from "vitest";
import {
  applyBlockTimestampsToEvents,
  assessCoverageConsistency,
  buildAuthoritativeMergeSupplements,
  collectBlocksMissingTimestamps,
  computeIndexedBoundaryStats,
  HISTORICAL_BACKFILL_REQUIRED,
  mergeAuthoritativeIndexedEvents,
  mergeAuthoritativeIndexedEventsWithDiagnostics,
  mergeMonotonicCoverageFields,
  resolveIncrementalFromBlock,
} from "@/lib/walletLedger/indexed/authoritativeEvents";
import {
  assignChainEventDedupeKey,
  buildCanonicalChainLogIdentity,
} from "@/lib/walletLedger/canonicalChainIdentity";
import type { WalletLedgerEvent } from "@/lib/walletLedger/types";

function event(
  keySeed: string,
  timestamp: number,
  blockNumber?: number,
  overrides: Partial<WalletLedgerEvent> = {}
): WalletLedgerEvent {
  const sharedDupCoords =
    keySeed === "dup"
      ? {
          txHash: "0xa7797ef2f04324b8b349dd01b2724196bdf8fdcc1a81e6ff67817a4c702ddab3",
          logIndex: 42,
        }
      : {};
  const logIndex =
    overrides.logIndex ??
    sharedDupCoords.logIndex ??
    keySeed.split("").reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % 1000;
  return assignChainEventDedupeKey({
    wallet: "0xwallet",
    conditionId: "cond",
    asset: overrides.asset ?? `asset-${keySeed}`,
    timestamp,
    type: "BUY",
    dedupeKey: "",
    source: "polygon",
    blockNumber,
    txHash: overrides.txHash ?? sharedDupCoords.txHash ?? `0xtx${keySeed}`,
    logIndex,
    ...overrides,
  });
}

describe("authoritativeEvents", () => {
  it("merges persisted DB events with delta and dedupes by key", () => {
    const persisted = [event("a", 100, 10), event("b", 200, 20)];
    const delta = [event("b", 200, 20), event("c", 300, 30)];
    const merged = mergeAuthoritativeIndexedEvents(persisted, delta);
    expect(merged.map((e) => e.dedupeKey)).toEqual([
      event("a", 100, 10).dedupeKey,
      event("b", 200, 20).dedupeKey,
      event("c", 300, 30).dedupeKey,
    ]);
    expect(merged).toHaveLength(3);
  });

  it("uses complete DB + delta when checkpoint is sparse", () => {
    const persisted = Array.from({ length: 100 }, (_, i) =>
      event(`db-${i}`, 1_000 + i, i + 1)
    );
    const delta = Array.from({ length: 5 }, (_, i) =>
      event(`delta-${i}`, 2_000 + i, 200 + i)
    );
    const merged = mergeAuthoritativeIndexedEvents(persisted, delta);
    expect(merged).toHaveLength(105);
    const assessment = assessCoverageConsistency({
      persistedDbEventCount: persisted.length,
      checkpointEventCount: delta.length,
      persistedCoverage: {
        extendsBeforeApiBoundary: true,
        eventsBeforeApiBoundary: 40,
        indexedOldestTimestamp: 900,
        eventHistoryComplete: true,
        chainId: "137",
        metricVersion: "phase2e1-v1",
        provider: "etherscan_v2",
      },
      fullHistory: true,
    });
    expect(assessment.sufficient).toBe(true);
    expect(assessment.checkpointSparse).toBe(true);
    expect(assessment.historicalBackfillRequired).toBe(false);
  });

  it("classifies missing DB history as historical_backfill_required", () => {
    const assessment = assessCoverageConsistency({
      persistedDbEventCount: 0,
      checkpointEventCount: 0,
      persistedCoverage: null,
      fullHistory: true,
    });
    expect(assessment.historicalBackfillRequired).toBe(true);
    expect(assessment.reason).toBe(HISTORICAL_BACKFILL_REQUIRED);
  });

  it("computes oldest indexed timestamp without stack overflow on large sets", () => {
    const events = Array.from({ length: 250_000 }, (_, i) =>
      event(`k-${i}`, 1_700_000_000 + i)
    );
    const stats = computeIndexedBoundaryStats(events, 1_700_100_000);
    expect(stats.indexedOldestTimestamp).toBe(1_700_000_000);
    expect(stats.eventsBeforeApiBoundary).toBeGreaterThan(0);
  });

  it("keeps pre-API coverage monotonic on incremental refresh", () => {
    const merged = mergeMonotonicCoverageFields(
      {
        extendsBeforeApiBoundary: true,
        eventsBeforeApiBoundary: 120,
        indexedOldestTimestamp: 1_600_000_000,
        eventHistoryComplete: true,
        chainId: "137",
        metricVersion: "phase2e1-v1",
        provider: "etherscan_v2",
        lastIndexedBlock: 50_000_000,
        lastReconstructedBlock: 50_000_000,
      },
      {
        extendsBeforeApiBoundary: false,
        eventsBeforeApiBoundary: 0,
        indexedOldestTimestamp: 1_700_000_000,
        lastIndexedBlock: 50_000_100,
        lastReconstructedBlock: 50_000_100,
      }
    );
    expect(merged.extendsBeforeApiBoundary).toBe(true);
    expect(merged.eventsBeforeApiBoundary).toBe(120);
    expect(merged.indexedOldestTimestamp).toBe(1_600_000_000);
    expect(merged.lastIndexedBlock).toBe(50_000_100);
  });

  it("resolves incremental fromBlock from persisted checkpoint", () => {
    expect(
      resolveIncrementalFromBlock({
        fullHistory: true,
        lastIndexedBlock: 12_345,
        persistedEventCount: 500,
        headBlock: 60_000_000,
        maxBlocksToScan: 100_000,
      })
    ).toBe(12_346);
  });

  it("complete checkpoint + complete DB yields same authoritative merge", () => {
    const persisted = [event("a", 100, 10), event("b", 200, 20)];
    const delta = [event("c", 300, 30)];
    const checkpointOnly = mergeAuthoritativeIndexedEvents(persisted, []);
    const withDelta = mergeAuthoritativeIndexedEvents(persisted, delta);
    expect(checkpointOnly).toHaveLength(2);
    expect(withDelta).toHaveLength(3);
    const fullCheckpoint = mergeAuthoritativeIndexedEvents([], [...persisted, ...delta]);
    expect(fullCheckpoint.map((e) => e.dedupeKey).sort()).toEqual(
      withDelta.map((e) => e.dedupeKey).sort()
    );
  });

  it("computes boundary stats from authoritative events", () => {
    const stats = computeIndexedBoundaryStats(
      [event("old", 1_000, 1), event("new", 2_000, 2)],
      1_500
    );
    expect(stats.eventsBeforeApiBoundary).toBe(1);
    expect(stats.extendsBeforeApiBoundary).toBe(true);
    expect(stats.indexedOldestTimestamp).toBe(1_000);
  });

  it("sparse persisted DB union full delta collapses to one canonical authoritative event", () => {
    const txHash =
      "0xa7797ef2f04324b8b349dd01b2724196bdf8fdcc1a81e6ff67817a4c702ddab3";
    const persisted = assignChainEventDedupeKey({
      wallet: "0xwallet",
      conditionId: "cond",
      asset: "asset-1",
      timestamp: 0,
      type: "BUY",
      dedupeKey:
        "0xa7797ef2f04324b8b349dd01b2724196bdf8fdcc1a81e6ff67817a4c702ddab3||asset-1|0|BUY|BUY|10.000000|0.500000|5.000000",
      source: "polygon",
      blockNumber: 47_546_811,
      logIndex: 42,
      txHash,
      shares: 10,
      cashUsd: 5,
      price: 0.5,
    });
    const delta = assignChainEventDedupeKey({
      wallet: "0xwallet",
      conditionId: "cond",
      asset: "asset-1",
      timestamp: 1_694_727_428,
      type: "BUY",
      dedupeKey: "",
      source: "polygon",
      blockNumber: 47_546_811,
      logIndex: 42,
      txHash,
      shares: 10,
      cashUsd: 5,
      price: 0.5,
    });
    const merged = mergeAuthoritativeIndexedEvents([persisted], [delta]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.dedupeKey).toBe(
      buildCanonicalChainLogIdentity({ txHash, logIndex: 42 })
    );
    expect(merged[0]?.timestamp).toBe(1_694_727_428);
  });

  describe("quality-aware authoritative merge", () => {
    it("A: persisted timestamp=0 + delta valid => one event with valid timestamp", () => {
      const persisted = [event("dup", 0, 47_546_811, { source: "polygon" })];
      const delta = [
        event("dup", 1_694_727_428, 47_546_811, {
          shares: 10,
        }),
      ];
      const { events, diagnostics } = mergeAuthoritativeIndexedEventsWithDiagnostics(
        persisted,
        delta
      );
      expect(events).toHaveLength(1);
      expect(events[0]?.timestamp).toBe(1_694_727_428);
      expect(events[0]?.blockNumber).toBe(47_546_811);
      expect(events[0]?.txHash).toBe(
        "0xa7797ef2f04324b8b349dd01b2724196bdf8fdcc1a81e6ff67817a4c702ddab3"
      );
      expect(diagnostics.timestampUpgrades).toBe(1);
    });

    it("B: persisted valid + delta timestamp=0 => persisted valid timestamp retained", () => {
      const persisted = [event("dup", 1_694_727_428, 47_546_811)];
      const delta = [event("dup", 0, 47_546_811)];
      const { events, diagnostics } = mergeAuthoritativeIndexedEventsWithDiagnostics(
        persisted,
        delta
      );
      expect(events).toHaveLength(1);
      expect(events[0]?.timestamp).toBe(1_694_727_428);
      expect(diagnostics.timestampUpgrades).toBe(0);
    });

    it("C: both valid and identical => deterministic one-event result", () => {
      const persisted = [event("dup", 1_694_727_428, 47_546_811)];
      const delta = [event("dup", 1_694_727_428, 47_546_811)];
      const first = mergeAuthoritativeIndexedEventsWithDiagnostics(persisted, delta);
      const second = mergeAuthoritativeIndexedEventsWithDiagnostics(persisted, delta);
      expect(first.events).toEqual(second.events);
      expect(first.events).toHaveLength(1);
      expect(first.diagnostics.timestampConflicts).toBe(0);
    });

    it("D: both valid but conflicting timestamp for same block => diagnostic emitted", () => {
      const persisted = [event("dup", 1_694_727_428, 47_546_811)];
      const delta = [event("dup", 1_694_800_000, 47_546_811)];
      const { events, diagnostics } = mergeAuthoritativeIndexedEventsWithDiagnostics(
        persisted,
        delta
      );
      expect(events).toHaveLength(1);
      expect(events[0]?.timestamp).toBe(1_694_727_428);
      expect(diagnostics.timestampConflicts).toBe(1);
      expect(diagnostics.timestampConflictSamples[0]?.dedupeKey).toBe(
        event("dup", 0, 47_546_811).dedupeKey
      );
    });

    it("E: delta better timestamp preserves ledger identity fields", () => {
      const persisted = [
        event("dup", 0, 47_546_811, {
          wallet: "0xd27cc742d023d06ef633a4c880cf1ff1836ec081",
          asset: "asset-1",
          type: "BUY",
          source: "polygon",
        }),
      ];
      const delta = [
        event("dup", 1_694_727_428, 47_546_811, {
          wallet: "0xd27cc742d023d06ef633a4c880cf1ff1836ec081",
          asset: "asset-1",
          type: "BUY",
          txHash: "0xa7797ef2f04324b8b349dd01b2724196bdf8fdcc1a81e6ff67817a4c702ddab3",
          shares: 149.91,
          cashUsd: 91.4451,
        }),
      ];
      const { events } = mergeAuthoritativeIndexedEventsWithDiagnostics(
        persisted,
        delta
      );
      expect(events[0]).toMatchObject({
        wallet: "0xd27cc742d023d06ef633a4c880cf1ff1836ec081",
        asset: "asset-1",
        type: "BUY",
        dedupeKey: event("dup", 0, 47_546_811).dedupeKey,
        timestamp: 1_694_727_428,
        blockNumber: 47_546_811,
        txHash: "0xa7797ef2f04324b8b349dd01b2724196bdf8fdcc1a81e6ff67817a4c702ddab3",
        shares: 149.91,
        cashUsd: 91.4451,
      });
    });

    it("G: supplements hydrate timestamp when persisted and delta are both zero", () => {
      const persisted = [
        event("dup", 0, 47_546_811, {
          txHash: "0xa7797ef2f04324b8b349dd01b2724196bdf8fdcc1a81e6ff67817a4c702ddab3",
        }),
      ];
      const delta = [event("dup", 0, 47_546_811)];
      const supplements = buildAuthoritativeMergeSupplements({
        verifiedTradeEvidence: [
          {
            txHash:
              "0xa7797ef2f04324b8b349dd01b2724196bdf8fdcc1a81e6ff67817a4c702ddab3",
            verifiedOnPolygon: true,
            blockNumber: 47_546_811,
            blockTimestamp: 1_694_727_428,
          },
        ],
      });
      const { events, diagnostics } = mergeAuthoritativeIndexedEventsWithDiagnostics(
        persisted,
        delta,
        { supplements }
      );
      expect(events[0]?.timestamp).toBe(1_694_727_428);
      expect(diagnostics.timestampUpgrades).toBeGreaterThan(0);
    });

    it("F: identical inputs produce identical output across two runs", () => {
      const persisted = [event("a", 0, 10), event("b", 1_700_000_000, 20)];
      const delta = [
        event("a", 1_000, 10),
        event("c", 1_694_727_428, 47_546_811),
      ];
      const first = mergeAuthoritativeIndexedEventsWithDiagnostics(persisted, delta);
      const second = mergeAuthoritativeIndexedEventsWithDiagnostics(persisted, delta);
      expect(first.events).toEqual(second.events);
      expect(first.diagnostics).toEqual(second.diagnostics);
    });
  });

  it("backfills missing timestamps so boundary stats can use persisted events", () => {
    const persisted = [
      { ...event("a", 0, 10), timestamp: 0 },
      { ...event("b", 0, 20), timestamp: 0 },
    ];
    const blocks = collectBlocksMissingTimestamps(persisted);
    expect(blocks).toEqual(new Set([10, 20]));

    const backfilled = applyBlockTimestampsToEvents(
      persisted,
      new Map([
        [10, 1_000],
        [20, 2_000],
      ])
    );
    expect(backfilled).toBe(2);
    const stats = computeIndexedBoundaryStats(persisted, 1_500);
    expect(stats.eventsBeforeApiBoundary).toBe(1);
    expect(stats.extendsBeforeApiBoundary).toBe(true);
  });
});
