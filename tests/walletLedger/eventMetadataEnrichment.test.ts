import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildChainCoordinateLogIndexLookup,
  planMetadataEnrichmentForEvent,
  resolveIncomingEventForEnrichment,
  type PersistedEventMetadataRow,
} from "@/lib/walletLedger/indexed/store/eventMetadataEnrichment";
import type { WalletLedgerEvent } from "@/lib/walletLedger/types";

function existing(
  overrides: Partial<PersistedEventMetadataRow> & { dedupeKey: string }
): PersistedEventMetadataRow {
  return {
    logIndex: null,
    blockNumber: null,
    blockTimestamp: null,
    ...overrides,
  };
}

function incoming(
  overrides: Partial<WalletLedgerEvent> & { dedupeKey: string }
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

describe("planMetadataEnrichmentForEvent", () => {
  it("A: existing log_index NULL + incoming logIndex=12 => patch logIndex", () => {
    const { patch, conflicts } = planMetadataEnrichmentForEvent(
      existing({ dedupeKey: "k1" }),
      incoming({ dedupeKey: "k1", logIndex: 12, blockNumber: 100 })
    );
    expect(patch.logIndex).toBe("12");
    expect(conflicts).toHaveLength(0);
  });

  it("B: existing logIndex=12 + incoming null => unchanged", () => {
    const { patch, conflicts } = planMetadataEnrichmentForEvent(
      existing({ dedupeKey: "k1", logIndex: "12" }),
      incoming({ dedupeKey: "k1" })
    );
    expect(patch.logIndex).toBeUndefined();
    expect(conflicts).toHaveLength(0);
  });

  it("C: existing logIndex=12 + incoming 13 => conflict, no patch", () => {
    const { patch, conflicts } = planMetadataEnrichmentForEvent(
      existing({ dedupeKey: "k1", logIndex: "12" }),
      incoming({ dedupeKey: "k1", logIndex: 13 })
    );
    expect(patch.logIndex).toBeUndefined();
    expect(conflicts).toEqual([
      {
        dedupeKey: "k1",
        field: "logIndex",
        existing: "12",
        incoming: "13",
      },
    ]);
  });

  it("resolves logIndex via chain-coordinate lookup when dedupe keys differ", () => {
    const lookup = buildChainCoordinateLogIndexLookup([
      incoming({
        dedupeKey: "chain-key",
        txHash: "0xabc",
        blockNumber: 100,
        asset: "asset-1",
        type: "BUY",
        shares: 10,
        cashUsd: 5,
        logIndex: 12,
      }),
    ]);
    const resolved = resolveIncomingEventForEnrichment(
      existing({
        dedupeKey: "api-key",
        txHash: "0xabc",
        blockNumber: 100,
        assetId: "asset-1",
        eventType: "BUY",
        shares: 10,
        cashUsd: 5,
      }),
      new Map([
        [
          "api-key",
          incoming({
            dedupeKey: "api-key",
            txHash: "0xabc",
            blockNumber: 100,
            asset: "asset-1",
            type: "BUY",
            shares: 10,
            cashUsd: 5,
          }),
        ],
      ]),
      lookup
    );
    expect(resolved?.logIndex).toBe(12);
  });

  it("D: existing timestamp null + incoming valid => patch blockTimestamp", () => {
    const { patch, conflicts } = planMetadataEnrichmentForEvent(
      existing({ dedupeKey: "k1", blockNumber: 100 }),
      incoming({ dedupeKey: "k1", timestamp: 1_700_000_000, blockNumber: 100 })
    );
    expect(patch.blockTimestamp).toBe(1_700_000_000);
    expect(conflicts).toHaveLength(0);
  });
});

describe("enrichPersistedLedgerEventMetadata (mocked db)", () => {
  const select = vi.fn();
  const update = vi.fn();
  const execute = vi.fn();
  const set = vi.fn();
  const where = vi.fn();
  const returning = vi.fn();
  const from = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    select.mockReset();
    update.mockReset();
    execute.mockReset();
    set.mockReset();
    where.mockReset();
    returning.mockReset();
    from.mockReset();

    returning.mockResolvedValue([{ dedupeKey: "k1" }]);
    where.mockReturnValue({ returning });
    set.mockReturnValue({ where });
    update.mockReturnValue({ set });
    execute.mockResolvedValue({ rows: [{ dedupe_key: "k1" }] });
    from.mockReturnValue({ where: vi.fn().mockResolvedValue([]) });
    select.mockReturnValue({ from });
  });

  async function loadModule() {
    vi.doMock("server-only", () => ({}));
    vi.doMock("@/lib/crossmarket/store/db", () => ({
      isDatabaseEnabled: () => true,
      getDb: () => ({ select, update, execute }),
    }));
    return import("@/lib/walletLedger/indexed/store/eventMetadataEnrichment");
  }

  it("E: second enrichment pass is idempotent (no additional writes)", async () => {
    const { enrichPersistedLedgerEventMetadata } = await loadModule();
    from.mockReturnValue({
      where: vi.fn().mockResolvedValue([
        {
          dedupeKey: "k1",
          logIndex: null,
          blockNumber: 100,
          blockTimestamp: null,
        },
      ]),
    });

    const events = [
      incoming({
        dedupeKey: "k1",
        logIndex: 12,
        timestamp: 1_700_000_000,
        blockNumber: 100,
      }),
    ];

    const first = await enrichPersistedLedgerEventMetadata("0xwallet", events);
    expect(first.logIndexBackfills).toBe(1);
    expect(first.timestampBackfills).toBe(1);

    from.mockReturnValue({
      where: vi.fn().mockResolvedValue([
        {
          dedupeKey: "k1",
          logIndex: "12",
          blockNumber: 100,
          blockTimestamp: 1_700_000_000,
        },
      ]),
    });
    execute.mockResolvedValue({ rows: [] });

    const second = await enrichPersistedLedgerEventMetadata("0xwallet", events);
    expect(second.logIndexBackfills).toBe(0);
    expect(second.timestampBackfills).toBe(0);
    expect(second.rowsUnchanged).toBe(1);
  });

  it("F: enrichment enables canonical reload ordering metadata on mapped row", async () => {
    const { enrichPersistedLedgerEventMetadata } = await loadModule();
    const { mapPersistedRowToWalletLedgerEvent } = await import(
      "@/lib/walletLedger/indexed/store/persistedEventLoader"
    );
    const { sortLedgerEventsCanonical } = await import("@/lib/walletLedger/eventOrder");

    from.mockReturnValue({
      where: vi.fn().mockResolvedValue([
        {
          dedupeKey: "k1",
          logIndex: null,
          blockNumber: 100,
          blockTimestamp: 1_700_000_000,
        },
      ]),
    });

    await enrichPersistedLedgerEventMetadata("0xwallet", [
      incoming({ dedupeKey: "k1", logIndex: 7, blockNumber: 100, timestamp: 1_700_000_000 }),
    ]);

    const reloaded = mapPersistedRowToWalletLedgerEvent({
      id: 1,
      walletAddress: "0xwallet",
      dedupeKey: "k1",
      txHash: "0xabc",
      logIndex: "7",
      blockNumber: 100,
      blockTimestamp: 1_700_000_000,
      eventType: "BUY",
      marketConditionId: "cond",
      assetId: "asset",
      shares: 1,
      cashUsd: 1,
      price: 1,
      source: "polygon",
    });
    const ordered = sortLedgerEventsCanonical([
      incoming({ dedupeKey: "k2", logIndex: 9, blockNumber: 100, timestamp: 1_700_000_000 }),
      reloaded,
    ]);
    expect(ordered[0]?.logIndex).toBe(7);
    expect(ordered[1]?.logIndex).toBe(9);
  });
});
