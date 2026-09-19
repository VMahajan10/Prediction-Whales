import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  assignChainEventDedupeKey,
  authoritativeEventMergeKey,
  buildCanonicalChainLogIdentity,
} from "@/lib/walletLedger/canonicalChainIdentity";
import type { WalletLedgerEvent } from "@/lib/walletLedger/types";
import type {
  PersistedAuthoritativeIndex,
  PersistedLedgerRowRef,
} from "@/lib/walletLedger/indexed/store/persistedAuthoritativeIndex";

function chainEvent(
  wallet: string,
  txHash: string,
  logIndex: number,
  overrides: Partial<WalletLedgerEvent> = {}
): WalletLedgerEvent {
  return assignChainEventDedupeKey({
    wallet,
    conditionId: "cond",
    asset: "asset-1",
    timestamp: 1_700_000_000,
    type: "BUY",
    shares: 10,
    cashUsd: 5,
    dedupeKey: "",
    source: "polygon",
    blockNumber: 100,
    txHash,
    logIndex,
    ...overrides,
  });
}

function rowFromEvent(
  id: number,
  event: WalletLedgerEvent,
  overrides: Partial<PersistedLedgerRowRef> = {}
): PersistedLedgerRowRef {
  return {
    id,
    dedupeKey: event.dedupeKey,
    canonicalIdentity: null,
    txHash: event.txHash ?? null,
    logIndex: event.logIndex ?? null,
    blockNumber: event.blockNumber ?? null,
    eventType: event.type,
    assetId: event.asset,
    shares: event.shares ?? null,
    cashUsd: event.cashUsd ?? null,
    source: event.source,
    walletAddress: event.wallet.toLowerCase(),
    ...overrides,
  };
}

function emptyIndex(): PersistedAuthoritativeIndex {
  return {
    mergeKeys: new Set(),
    byDedupeKey: new Map(),
    byCanonicalIdentity: new Map(),
    byPhysicalLog: new Map(),
  };
}

describe("canonicalEventReconciliation", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock("server-only", () => ({}));
  });

  it("A/B: existing merge key already present => satisfied without insert", async () => {
    const {
      createEmptyReconciliationDiagnostics,
      reconcileAuthoritativeEventBeforeInsert,
    } = await import(
      "@/lib/walletLedger/indexed/store/canonicalEventReconciliation"
    );
    const wallet = "0xwallet";
    const event = chainEvent(wallet, "0xabc", 7);
    const index = emptyIndex();
    index.mergeKeys.add(authoritativeEventMergeKey(event));

    const diagnostics = createEmptyReconciliationDiagnostics();
    const outcome = await reconcileAuthoritativeEventBeforeInsert(
      wallet,
      event,
      index,
      diagnostics
    );
    expect(outcome.kind).toBe("satisfied");
    expect(diagnostics.canonicalMatches).toBe(1);
    expect(diagnostics.newCanonicalInserts).toBe(0);
  });

  it("D: same dedupe_key but different physical coordinates => ambiguous collision", async () => {
    const {
      createEmptyReconciliationDiagnostics,
      reconcileAuthoritativeEventBeforeInsert,
    } = await import(
      "@/lib/walletLedger/indexed/store/canonicalEventReconciliation"
    );
    const wallet = "0xwallet";
    const event = chainEvent(wallet, "0x111", 1);
    const row = rowFromEvent(3, event, {
      txHash: "0x999",
      logIndex: 2,
      shares: 99,
    });
    const index = emptyIndex();
    index.byDedupeKey.set(event.dedupeKey, row);

    const diagnostics = createEmptyReconciliationDiagnostics();
    const outcome = await reconcileAuthoritativeEventBeforeInsert(
      wallet,
      event,
      index,
      diagnostics
    );
    expect(outcome.kind).toBe("ambiguous_collision");
    expect(diagnostics.ambiguousCollisions).toBe(1);
  });

  it("fresh authoritative event with no persisted match => insert", async () => {
    const {
      createEmptyReconciliationDiagnostics,
      reconcileAuthoritativeEventBeforeInsert,
    } = await import(
      "@/lib/walletLedger/indexed/store/canonicalEventReconciliation"
    );
    const event = chainEvent("0xwallet", "0xnew", 4);
    const diagnostics = createEmptyReconciliationDiagnostics();
    const outcome = await reconcileAuthoritativeEventBeforeInsert(
      "0xwallet",
      event,
      emptyIndex(),
      diagnostics
    );
    expect(outcome.kind).toBe("insert");
    expect(diagnostics.newCanonicalInserts).toBe(1);
  });

  it("parses canonical chain dedupe keys for 18f0 collision", async () => {
    const { parseCanonicalChainDedupeKey } = await import(
      "@/lib/walletLedger/indexed/store/canonicalEventReconciliation"
    );
    const dedupeKey =
      "chain|137|0x311d50cbc0773e6b693e44855040353e84e9ece2f6d65f9dabc731b9b9027da0|1013";
    const parsed = parseCanonicalChainDedupeKey(dedupeKey);
    expect(parsed?.logIndex).toBe(1013);
    expect(buildCanonicalChainLogIdentity({
      txHash: parsed!.txHash,
      logIndex: parsed!.logIndex,
    })).toBe(dedupeKey);
  });

  it("economicFieldsAgree rejects conflicting shares", async () => {
    const { economicFieldsAgree, persistedRowToEvent } = await import(
      "@/lib/walletLedger/indexed/store/canonicalEventReconciliation"
    );
    const event = chainEvent("0xwallet", "0xabc", 1);
    const row = rowFromEvent(1, event, { shares: 999 });
    expect(economicFieldsAgree(event, row)).toBe(false);
    expect(economicFieldsAgree(event, rowFromEvent(2, event))).toBe(true);
  });
});
