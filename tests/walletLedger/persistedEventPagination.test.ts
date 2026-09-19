import { describe, expect, it } from "vitest";
import {
  buildAuthoritativeEventMergeStats,
  countDuplicateDeltaEvents,
  mergeAuthoritativeIndexedEvents,
} from "@/lib/walletLedger/indexed/authoritativeEvents";
import {
  classifyExecutionOutcome,
  QueryScaleError,
} from "@/lib/walletLedger/indexed/shadow/infraClassification";
import {
  buildKeysetCursorFromRows,
  loadPersistedEventsWithFetcher,
  paginateSortedPersistedRows,
  PERSISTED_EVENT_PAGE_SIZE,
  type PersistedEventRowSlice,
} from "@/lib/walletLedger/indexed/store/persistedEventLoader";
import { authoritativeEventMergeKey } from "@/lib/walletLedger/canonicalChainIdentity";
import type { WalletLedgerEvent } from "@/lib/walletLedger/types";

function makeRow(input: {
  id: number;
  blockNumber: number | null;
  dedupeKey?: string;
}): PersistedEventRowSlice {
  const dedupeKey = input.dedupeKey ?? `dedupe-${input.id}`;
  return {
    id: input.id,
    walletAddress: "0xwallet",
    dedupeKey,
    txHash: `0xtx${input.id}`,
    blockNumber: input.blockNumber,
    blockTimestamp: 1_700_000_000 + input.id,
    eventType: "BUY",
    marketConditionId: "cond",
    assetId: "asset",
    shares: 1,
    cashUsd: 1,
    price: 0.5,
    source: "polygon",
  };
}

function buildSyntheticRows(count: number): PersistedEventRowSlice[] {
  const rows: PersistedEventRowSlice[] = [];
  for (let i = 0; i < count; i += 1) {
    const blockNumber = Math.floor(i / 50);
    rows.push(makeRow({ id: i + 1, blockNumber }));
  }
  return rows;
}

function ledgerEvent(dedupeKey: string, blockNumber?: number): WalletLedgerEvent {
  return {
    wallet: "0xwallet",
    conditionId: "cond",
    asset: "asset",
    timestamp: 1_000,
    type: "BUY",
    dedupeKey,
    source: "polygon",
    blockNumber,
  };
}

describe("persistedEventPagination", () => {
  it("A. paginates 200k events losslessly", () => {
    const rows = buildSyntheticRows(200_000);
    const loaded = paginateSortedPersistedRows(rows, PERSISTED_EVENT_PAGE_SIZE);
    expect(loaded).toHaveLength(200_000);
    expect(new Set(loaded.map((row) => row.dedupeKey)).size).toBe(200_000);
    expect(loaded.map((row) => row.id)).toEqual(rows.map((row) => row.id));
  });

  it("B. paginates 700k events losslessly", () => {
    const rows = buildSyntheticRows(700_000);
    const loaded = paginateSortedPersistedRows(rows, PERSISTED_EVENT_PAGE_SIZE);
    expect(loaded).toHaveLength(700_000);
    expect(new Set(loaded.map((row) => row.dedupeKey)).size).toBe(700_000);
  }, 20_000);

  it("C. handles many rows sharing block_number without skips or duplicates", () => {
    const sharedBlock = 42_000;
    const rows = Array.from({ length: 2_500 }, (_, i) =>
      makeRow({ id: i + 1, blockNumber: sharedBlock })
    );
    const loaded = paginateSortedPersistedRows(rows, 500);
    expect(loaded).toHaveLength(2_500);
    expect(loaded.map((row) => row.id)).toEqual(rows.map((row) => row.id));
    expect(new Set(loaded.map((row) => row.dedupeKey)).size).toBe(2_500);
  });

  it("D. rerun returns the exact same ordered event set", async () => {
    const rows = buildSyntheticRows(12_345);
    const fetchPage = async (
      cursor: ReturnType<typeof buildKeysetCursorFromRows>,
      pageSize: number
    ) => {
      const { sliceKeysetPage } = await import(
        "@/lib/walletLedger/indexed/store/persistedEventLoader"
      );
      return sliceKeysetPage(rows, cursor, pageSize);
    };
    const first = await loadPersistedEventsWithFetcher("0xwallet", fetchPage, {
      pageSize: 1_000,
    });
    const second = await loadPersistedEventsWithFetcher("0xwallet", fetchPage, {
      pageSize: 1_000,
    });
    expect(second.events.map((event) => event.dedupeKey)).toEqual(
      first.events.map((event) => event.dedupeKey)
    );
  });

  it("E. retries the same page after a transient DB failure", async () => {
    const rows = buildSyntheticRows(12_000);
    let pageCalls = 0;
    const fetchPage = async (
      cursor: ReturnType<typeof buildKeysetCursorFromRows>,
      pageSize: number
    ) => {
      pageCalls += 1;
      if (pageCalls === 2) {
        throw new Error("fetch failed");
      }
      const { sliceKeysetPage } = await import(
        "@/lib/walletLedger/indexed/store/persistedEventLoader"
      );
      return sliceKeysetPage(rows, cursor, pageSize);
    };
    const { events } = await loadPersistedEventsWithFetcher("0xwallet", fetchPage, {
      pageSize: 5_000,
    });
    expect(events).toHaveLength(12_000);
    expect(pageCalls).toBeGreaterThan(12_000 / 5_000);
  });

  it("F. classifies deterministic page query failure as internal_error", () => {
    const err = new QueryScaleError("persisted event page load failed", new Error("Failed query"));
    expect(classifyExecutionOutcome(err)).toBe("internal_error");
    expect(classifyExecutionOutcome(new Error("Failed query"))).toBe("wallet_failed");
    expect(classifyExecutionOutcome(new Error("Neon fetch failed"))).toBe("deferred_infra");
  });
});

describe("authoritative DB + delta merge", () => {
  it("G. persisted 200k + 10 new yields authoritative 200010 minus overlaps", () => {
    const persisted = Array.from({ length: 200_000 }, (_, i) =>
      ledgerEvent(`db-${i}`, i)
    );
    const delta = [
      ...Array.from({ length: 5 }, (_, i) => ledgerEvent(`db-${i}`, i)),
      ...Array.from({ length: 10 }, (_, i) => ledgerEvent(`new-${i}`, 200_000 + i)),
    ];
    const duplicateDeltaEvents = countDuplicateDeltaEvents(persisted, delta);
    const authoritative = mergeAuthoritativeIndexedEvents(persisted, delta);
    const stats = buildAuthoritativeEventMergeStats({
      persistedDbEventCount: persisted.length,
      deltaEventCount: delta.length,
      duplicateDeltaEvents,
      checkpointEventCount: delta.length,
      authoritativeEventCount: authoritative.length,
      usedPersistedDbBase: true,
    });
    expect(duplicateDeltaEvents).toBe(5);
    expect(stats.newDeltaEvents).toBe(10);
    expect(authoritative).toHaveLength(200_010);
  });

  it("H. sparse checkpoint does not replace complete DB history", () => {
    const persisted = Array.from({ length: 200_000 }, (_, i) =>
      ledgerEvent(`db-${i}`, i)
    );
    const delta = Array.from({ length: 100 }, (_, i) =>
      ledgerEvent(`delta-${i}`, 300_000 + i)
    );
    const authoritative = mergeAuthoritativeIndexedEvents(persisted, delta);
    const stats = buildAuthoritativeEventMergeStats({
      persistedDbEventCount: persisted.length,
      deltaEventCount: delta.length,
      duplicateDeltaEvents: countDuplicateDeltaEvents(persisted, delta),
      checkpointEventCount: delta.length,
      authoritativeEventCount: authoritative.length,
      usedPersistedDbBase: true,
    });
    expect(stats.checkpointSparse).toBe(true);
    expect(authoritative).toHaveLength(200_100);
    expect(authoritative[0]?.blockNumber).toBe(0);
    expect(authoritative[0]?.dedupeKey).toBe(
      authoritativeEventMergeKey(persisted[0]!)
    );
    expect(authoritative.at(-1)?.blockNumber).toBe(300_099);
  });
});
