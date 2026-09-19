import { describe, expect, it } from "vitest";
import {
  compareLedgerEventsCanonical,
  sortLedgerEventsCanonical,
  summarizeCanonicalOrderDiagnostics,
} from "@/lib/walletLedger/eventOrder";
import {
  buildPositionLifecycles,
  splitEventsIntoEpisodes,
} from "@/lib/walletLedger/ledger";
import { mergeAuthoritativeIndexedEventsWithDiagnostics } from "@/lib/walletLedger/indexed/authoritativeEvents";
import {
  mapPersistedRowToWalletLedgerEvent,
  type PersistedEventRowSlice,
} from "@/lib/walletLedger/indexed/store/persistedEventLoader";
import type { WalletLedgerEvent } from "@/lib/walletLedger/types";

function event(
  overrides: Partial<WalletLedgerEvent> & Pick<WalletLedgerEvent, "dedupeKey">
): WalletLedgerEvent {
  return {
    wallet: "0xwallet",
    conditionId: "cond",
    asset: "asset",
    timestamp: 0,
    type: "BUY",
    source: "polygon",
    ...overrides,
  };
}

describe("canonical ledger event ordering", () => {
  it("A: block 100 valid timestamp before block 101 timestamp=0", () => {
    const ordered = sortLedgerEventsCanonical([
      event({
        dedupeKey: "b",
        blockNumber: 101,
        logIndex: 1,
        timestamp: 0,
      }),
      event({
        dedupeKey: "a",
        blockNumber: 100,
        logIndex: 1,
        timestamp: 1_700_000_000,
      }),
    ]);
    expect(ordered[0]?.blockNumber).toBe(100);
    expect(ordered[1]?.blockNumber).toBe(101);
  });

  it("B: same block logIndex ordering wins over reversed timestamps", () => {
    const ordered = sortLedgerEventsCanonical([
      event({
        dedupeKey: "late",
        blockNumber: 100,
        logIndex: 9,
        timestamp: 1,
      }),
      event({
        dedupeKey: "early",
        blockNumber: 100,
        logIndex: 4,
        timestamp: 9_999,
      }),
    ]);
    expect(ordered.map((row) => row.dedupeKey)).toEqual(["early", "late"]);
  });

  it("C: full exit then re-entry with timestamp=0 splits into completed + open episodes", () => {
    const episodes = splitEventsIntoEpisodes([
      event({
        dedupeKey: "buy1",
        blockNumber: 100,
        logIndex: 1,
        type: "BUY",
        shares: 10,
        cashUsd: 5,
        timestamp: 1_000,
      }),
      event({
        dedupeKey: "sell1",
        blockNumber: 101,
        logIndex: 2,
        type: "SELL",
        shares: 10,
        cashUsd: 6,
        timestamp: 2_000,
      }),
      event({
        dedupeKey: "buy2",
        blockNumber: 102,
        logIndex: 3,
        type: "BUY",
        shares: 4,
        cashUsd: 2,
        timestamp: 0,
      }),
    ]);
    expect(episodes).toHaveLength(2);
    expect(episodes[0]?.map((row) => row.dedupeKey)).toEqual(["buy1", "sell1"]);
    expect(episodes[1]?.map((row) => row.dedupeKey)).toEqual(["buy2"]);
  });

  it("D: same block/timestamp uses logIndex for replay order", () => {
    const ordered = sortLedgerEventsCanonical([
      event({
        dedupeKey: "second",
        blockNumber: 50,
        logIndex: 8,
        timestamp: 1_000,
        type: "SELL",
        shares: 1,
        cashUsd: 1,
      }),
      event({
        dedupeKey: "first",
        blockNumber: 50,
        logIndex: 2,
        timestamp: 1_000,
        type: "BUY",
        shares: 1,
        cashUsd: 1,
      }),
    ]);
    expect(ordered.map((row) => row.dedupeKey)).toEqual(["first", "second"]);
  });

  it("E: persist loader round-trip preserves logIndex for lifecycle rebuild", async () => {
    const original = event({
      dedupeKey: "persist",
      blockNumber: 100,
      logIndex: 7,
      timestamp: 1_700_000_000,
      shares: 5,
      cashUsd: 2,
    });
    const row: PersistedEventRowSlice = {
      id: 1,
      walletAddress: original.wallet,
      dedupeKey: original.dedupeKey,
      txHash: original.txHash ?? null,
      logIndex: "7",
      blockNumber: original.blockNumber ?? null,
      blockTimestamp: original.timestamp,
      eventType: original.type,
      marketConditionId: original.conditionId,
      assetId: original.asset,
      shares: original.shares ?? null,
      cashUsd: original.cashUsd ?? null,
      price: original.price ?? null,
      source: original.source,
    };
    const reloaded = mapPersistedRowToWalletLedgerEvent(row);
    const before = await buildPositionLifecycles(original.wallet, [original]);
    const after = await buildPositionLifecycles(reloaded.wallet, [reloaded]);
    expect(reloaded.logIndex).toBe(7);
    expect(after.positions[0]?.completed).toBe(before.positions[0]?.completed);
    expect(after.positions[0]?.positionRoi).toBe(before.positions[0]?.positionRoi);
  });

  it("F: quality-aware merge retains valid delta logIndex over persisted null", () => {
    const persisted = [
      event({
        dedupeKey: "dup",
        blockNumber: 100,
        timestamp: 0,
      }),
    ];
    const delta = [
      event({
        dedupeKey: "dup",
        blockNumber: 100,
        logIndex: 12,
        timestamp: 1_694_727_428,
      }),
    ];
    const { events } = mergeAuthoritativeIndexedEventsWithDiagnostics(
      persisted,
      delta
    );
    expect(events[0]?.logIndex).toBe(12);
  });

  it("G: timestamp=0 without chain coordinates sorts after valid-timestamp events", () => {
    const ordered = sortLedgerEventsCanonical([
      event({ dedupeKey: "zero", timestamp: 0 }),
      event({ dedupeKey: "valid", timestamp: 1_700_000_000 }),
    ]);
    expect(ordered[0]?.dedupeKey).toBe("valid");
    expect(ordered[1]?.dedupeKey).toBe("zero");
    const diagnostics = summarizeCanonicalOrderDiagnostics(ordered);
    expect(diagnostics.withoutChainOrder).toBe(2);
  });

  it("compareLedgerEventsCanonical is deterministic", () => {
    const input = [
      event({ dedupeKey: "c", blockNumber: 3, logIndex: 1, timestamp: 0 }),
      event({ dedupeKey: "a", blockNumber: 1, logIndex: 2, timestamp: 9 }),
      event({ dedupeKey: "b", blockNumber: 2, logIndex: 1, timestamp: 0 }),
    ];
    const first = sortLedgerEventsCanonical(input);
    const second = sortLedgerEventsCanonical(input);
    expect(first).toEqual(second);
    expect(compareLedgerEventsCanonical(first[0]!, first[0]!)).toBe(0);
  });
});
