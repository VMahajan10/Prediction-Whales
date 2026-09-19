import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  assignChainEventDedupeKey,
  authoritativeEventMergeKey,
  buildCanonicalChainLogIdentity,
} from "@/lib/walletLedger/canonicalChainIdentity";
import type { WalletLedgerEvent } from "@/lib/walletLedger/types";

function chainEvent(
  seed: string,
  blockNumber: number,
  logIndex: number,
  wallet = "0xwallet"
): WalletLedgerEvent {
  return assignChainEventDedupeKey({
    wallet,
    conditionId: "cond",
    asset: `asset-${seed}`,
    timestamp: 1_700_000_000,
    type: "BUY",
    dedupeKey: "",
    source: "polygon",
    blockNumber,
    logIndex,
    txHash: `0xtx${seed}`,
  });
}

describe("twoPhaseHydration", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("A: baseline incomplete => derived commit gate stays closed", async () => {
    const { shouldCommitDerivedStateAfterBaseline } = await import(
      "@/lib/walletLedger/indexed/store/persistWalletHistory"
    );
    expect(shouldCommitDerivedStateAfterBaseline(false, true)).toBe(false);
    expect(shouldCommitDerivedStateAfterBaseline(false, false)).toBe(false);
  });

  it("C: same physical log under legacy dedupe_key => bucket A classification", async () => {
    const { classifyMissingAuthoritativeIdentity } = await import(
      "@/lib/walletLedger/indexed/store/missingIdentityAudit"
    );
    const event = chainEvent("legacy", 100, 5);
    const canonical = buildCanonicalChainLogIdentity({
      txHash: event.txHash!,
      logIndex: event.logIndex!,
    });
    const index = {
      mergeKeys: new Set<string>(),
      byDedupeKey: new Map([
        [
          "legacy-timestamp-key",
          {
            id: 1,
            dedupeKey: "legacy-timestamp-key",
            canonicalIdentity: null,
            txHash: event.txHash!,
            logIndex: event.logIndex!,
            blockNumber: 100,
            eventType: "BUY",
            assetId: event.asset,
            shares: null,
            cashUsd: null,
            source: "polygon",
            walletAddress: "0xwallet",
          },
        ],
      ]),
      byCanonicalIdentity: new Map(),
      byPhysicalLog: new Map([
        [
          `${event.txHash!.toLowerCase()}|${event.logIndex}`,
          {
            id: 1,
            dedupeKey: "legacy-timestamp-key",
            canonicalIdentity: null,
            txHash: event.txHash!,
            logIndex: event.logIndex!,
            blockNumber: 100,
            eventType: "BUY",
            assetId: event.asset,
            shares: null,
            cashUsd: null,
            source: "polygon",
            walletAddress: "0xwallet",
          },
        ],
      ]),
    };

    const report = classifyMissingAuthoritativeIdentity(event, index);
    expect(report.bucket).toBe("A");
    expect(report.canonicalIdentity).toBe(canonical);
  });

  it("D: different physical logs on legacy dedupe_key => explicit bucket B", async () => {
    const { assertNoLegacyDedupeKeyCollision, LegacyDedupeKeyCollisionError } =
      await import("@/lib/walletLedger/indexed/store/persistedAuthoritativeIndex");
    const event = chainEvent("new", 200, 9);
    const index = {
      mergeKeys: new Set<string>(),
      byDedupeKey: new Map([
        [
          event.dedupeKey,
          {
            id: 99,
            dedupeKey: event.dedupeKey,
            canonicalIdentity: null,
            txHash: "0xother",
            logIndex: 1,
            blockNumber: 50,
            eventType: "BUY",
            assetId: "other",
            shares: null,
            cashUsd: null,
            source: "polygon",
            walletAddress: "0xwallet",
          },
        ],
      ]),
      byCanonicalIdentity: new Map(),
      byPhysicalLog: new Map(),
    };

    expect(() => assertNoLegacyDedupeKeyCollision(event, index)).toThrow(
      LegacyDedupeKeyCollisionError
    );
  });

  it("E: non-persistable class-D event excluded from persistable denominator", async () => {
    const {
      summarizePersistableAuthoritativeEvents,
      assessAuthoritativeBaselineCompleteness,
    } = await import("@/lib/walletLedger/indexed/store/authoritativePersistence");

    const unresolved = assignChainEventDedupeKey({
      wallet: "0xwallet",
      conditionId: "cond",
      asset: "asset",
      timestamp: 1_700_000_000,
      type: "BUY",
      dedupeKey: "",
      source: "polygon",
      blockNumber: 100,
      txHash: "0xunresolved",
    });
    const summary = summarizePersistableAuthoritativeEvents([unresolved]);
    expect(summary.unresolvedClassDTotal).toBe(1);
    expect(summary.persistableTotal).toBe(0);

    const assessment = assessAuthoritativeBaselineCompleteness({
      authoritativeEvents: [unresolved],
      persistedDedupeKeys: new Set(),
      persistedEventsBefore: 0,
      lastIndexedBlock: null,
    });
    expect(assessment.baselineComplete).toBe(true);
    expect(assessment.persistableMissingBefore).toBe(0);
  });

  it("B: Phase 1 partial write then retry is idempotent at candidate selection", async () => {
    const {
      assessAuthoritativeBaselineCompleteness,
      selectAuthoritativePersistenceCandidates,
      resolveAuthoritativePersistenceMode,
    } = await import("@/lib/walletLedger/indexed/store/authoritativePersistence");

    const events = [chainEvent("partial", 10, 1), chainEvent("partial", 11, 2)];
    const firstPassKeys = new Set([
      authoritativeEventMergeKey(events[0]!),
    ]);
    const firstAssessment = assessAuthoritativeBaselineCompleteness({
      authoritativeEvents: events,
      persistedDedupeKeys: firstPassKeys,
      persistedEventsBefore: 1,
      lastIndexedBlock: 100,
    });
    expect(resolveAuthoritativePersistenceMode(firstAssessment)).toBe(
      "baseline_repair"
    );
    const firstCandidates = selectAuthoritativePersistenceCandidates({
      mode: "baseline_repair",
      authoritativeEvents: events,
      deltaEvents: [],
      persistedDedupeKeys: firstPassKeys,
    });
    expect(firstCandidates).toHaveLength(1);

    const secondPassKeys = new Set(events.map((e) => authoritativeEventMergeKey(e)));
    const secondCandidates = selectAuthoritativePersistenceCandidates({
      mode: resolveAuthoritativePersistenceMode(
        assessAuthoritativeBaselineCompleteness({
          authoritativeEvents: events,
          persistedDedupeKeys: secondPassKeys,
          persistedEventsBefore: 2,
          lastIndexedBlock: 100,
        })
      ),
      authoritativeEvents: events,
      deltaEvents: [],
      persistedDedupeKeys: secondPassKeys,
    });
    expect(secondCandidates).toHaveLength(0);
  });

  it("F: exact replay mismatch => derived commit gate stays closed", async () => {
    const { shouldCommitDerivedStateAfterBaseline } = await import(
      "@/lib/walletLedger/indexed/store/persistWalletHistory"
    );
    expect(shouldCommitDerivedStateAfterBaseline(true, false)).toBe(false);
  });

  it("G: successful baseline + explicit commit flag => derived commit gate opens", async () => {
    const { shouldCommitDerivedStateAfterBaseline } = await import(
      "@/lib/walletLedger/indexed/store/persistWalletHistory"
    );
    expect(shouldCommitDerivedStateAfterBaseline(true, true)).toBe(true);
    expect(shouldCommitDerivedStateAfterBaseline(true, undefined)).toBe(false);
  });
});
