import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WalletLedgerEvent } from "@/lib/walletLedger/types";

function event(
  dedupeKey: string,
  blockNumber?: number
): WalletLedgerEvent {
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

describe("wallet event persistence planning", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("dedupeCandidateEvents collapses duplicate keys within one batch", async () => {
    vi.doMock("server-only", () => ({}));
    const { dedupeCandidateEvents } = await import(
      "@/lib/walletLedger/indexed/store/persistWalletHistory"
    );
    const input = [
      event("k1", 100),
      event("k1", 101),
      event("k2", 102),
    ];
    const deduped = dedupeCandidateEvents(input);
    expect(deduped).toHaveLength(2);
    expect(deduped.map((e) => e.dedupeKey)).toEqual(["k1", "k2"]);
    expect(deduped[0]?.blockNumber).toBe(100);
  });

  it("selectPersistenceCandidateEvents returns only post-checkpoint chain delta", async () => {
    vi.doMock("server-only", () => ({}));
    const { selectPersistenceCandidateEvents } = await import(
      "@/lib/walletLedger/indexed/store/persistWalletHistory"
    );
    const all = [
      event("old", 1_000),
      event("new-1", 1_001),
      event("new-2", 1_002),
    ];
    expect(
      selectPersistenceCandidateEvents(all, {
        lastIndexedBlock: 1_000,
        throughBlock: 1_002,
      }).map((e) => e.dedupeKey)
    ).toEqual(["new-1", "new-2"]);
    expect(
      selectPersistenceCandidateEvents(all, {
        lastIndexedBlock: 1_002,
        throughBlock: 1_002,
      })
    ).toHaveLength(0);
    expect(
      selectPersistenceCandidateEvents(all, {
        lastIndexedBlock: null,
        throughBlock: 1_002,
      })
    ).toHaveLength(3);
  });

  it("planEventInsertChunks bounds 1M candidates into fixed-size chunks", async () => {
    vi.doMock("server-only", () => ({}));
    const { EVENT_PERSIST_CHUNK_SIZE, planEventInsertChunks } = await import(
      "@/lib/walletLedger/indexed/store/persistWalletHistory"
    );
    const items = Array.from({ length: 1_000_000 }, (_, i) => i);
    const chunks = planEventInsertChunks(items);
    expect(chunks).toHaveLength(Math.ceil(1_000_000 / EVENT_PERSIST_CHUNK_SIZE));
    expect(chunks[0]).toHaveLength(EVENT_PERSIST_CHUNK_SIZE);
    expect(chunks.at(-1)).toHaveLength(1_000_000 % EVENT_PERSIST_CHUNK_SIZE || EVENT_PERSIST_CHUNK_SIZE);
  });
});

describe("upsertWalletLedgerEvents (mocked db)", () => {
  const returning = vi.fn();
  const onConflictDoNothing = vi.fn();
  const values = vi.fn();
  const insert = vi.fn();
  const select = vi.fn();
  const execute = vi.fn();
  const limit = vi.fn();
  const orderBy = vi.fn();
  const where = vi.fn();
  const from = vi.fn();
  let persistedIndexRows: Array<{
    id: number;
    dedupeKey: string;
    canonicalIdentity: string | null;
    txHash: string | null;
    logIndex: string | null;
    blockNumber: number | null;
    walletAddress: string;
    eventType: string;
    marketConditionId: string | null;
    assetId: string | null;
    shares: number | null;
    cashUsd: number | null;
    source: string;
  }>;
  let nextRowId = 1;

  function seedPersistedRow(dedupeKey: string, walletAddress = "0xwallet"): void {
    persistedIndexRows.push({
      id: nextRowId++,
      dedupeKey,
      canonicalIdentity: null,
      txHash: null,
      logIndex: null,
      blockNumber: null,
      walletAddress,
      eventType: "BUY",
      marketConditionId: null,
      assetId: "asset",
      shares: null,
      cashUsd: null,
      source: "polygon",
    });
  }

  beforeEach(() => {
    vi.resetModules();
    returning.mockReset();
    onConflictDoNothing.mockReset();
    values.mockReset();
    insert.mockReset();
    select.mockReset();
    execute.mockReset();
    limit.mockReset();
    orderBy.mockReset();
    where.mockReset();
    from.mockReset();
    persistedIndexRows = [];
    nextRowId = 1;

    onConflictDoNothing.mockReturnValue({ returning });
    values.mockReturnValue({ onConflictDoNothing });
    insert.mockReturnValue({ values });
    limit.mockImplementation(async () => persistedIndexRows);
    orderBy.mockReturnValue({ limit });
    where.mockReturnValue({ orderBy });
    from.mockReturnValue({ where });
    select.mockReturnValue({ from });
    execute.mockResolvedValue({ rowCount: 0, rows: [] });
    returning.mockImplementation(async () => {
      const lastValues = values.mock.calls.at(-1)?.[0] as Array<{ dedupeKey: string }>;
      const inserted: Array<{ dedupeKey: string }> = [];
      for (const row of lastValues ?? []) {
        if (persistedIndexRows.some((existing) => existing.dedupeKey === row.dedupeKey)) {
          continue;
        }
        seedPersistedRow(row.dedupeKey);
        inserted.push({ dedupeKey: row.dedupeKey });
      }
      return inserted;
    });
  });

  async function loadModule() {
    vi.doMock("server-only", () => ({}));
    vi.doMock("@/lib/crossmarket/store/db", () => ({
      isDatabaseEnabled: () => true,
      getDb: () => ({ insert, select, execute }),
    }));
    return import("@/lib/walletLedger/indexed/store/persistWalletHistory");
  }

  it("A: large existing index + 10 new — inserts only novel keys via reconciliation", async () => {
    const { upsertWalletLedgerEvents } = await loadModule();
    const existingCount = 2_500;
    persistedIndexRows = Array.from({ length: existingCount }, (_, i) => ({
      id: i + 1,
      dedupeKey: `existing-${i}`,
      canonicalIdentity: null,
      txHash: null,
      logIndex: null,
      blockNumber: i + 1,
      walletAddress: "0xwallet",
      eventType: "BUY",
      marketConditionId: null,
      assetId: "asset",
      shares: null,
      cashUsd: null,
      source: "polygon",
    }));
    nextRowId = existingCount + 1;
    const incoming = [
      ...Array.from({ length: 10 }, (_, i) => event(`new-${i}`, 9_000 + i)),
      ...Array.from({ length: existingCount }, (_, i) => event(`existing-${i}`, 1 + i)),
    ];

    const stats = await upsertWalletLedgerEvents("0xwallet", incoming);
    expect(stats.inserted).toBe(10);
    expect(stats.skippedExisting).toBe(existingCount);
    expect(stats.candidateEvents).toBe(10);
    expect(stats.novelEvents).toHaveLength(10);
    expect(stats.chunkCount).toBeGreaterThan(0);
  });

  it("B: rerun same 10 — 0 inserted, 10 skippedExisting", async () => {
    const { upsertWalletLedgerEvents } = await loadModule();
    const incoming = Array.from({ length: 10 }, (_, i) => event(`dup-${i}`, 100 + i));
    for (let i = 0; i < 10; i += 1) {
      seedPersistedRow(`dup-${i}`);
    }
    const stats = await upsertWalletLedgerEvents("0xwallet", incoming);
    expect(stats.inserted).toBe(0);
    expect(stats.skippedExisting).toBe(10);
    expect(stats.novelEvents).toHaveLength(0);
  });

  it("C: duplicate candidates within same batch — one row per dedupe_key attempted", async () => {
    const { upsertWalletLedgerEvents } = await loadModule();
    returning.mockImplementation(async () => {
      const lastValues = values.mock.calls.at(-1)?.[0] as Array<{ dedupeKey: string }>;
      return (lastValues ?? []).map((row) => ({ dedupeKey: row.dedupeKey }));
    });
    const stats = await upsertWalletLedgerEvents("0xwallet", [
      event("same-key", 1),
      event("same-key", 2),
      event("other", 3),
    ]);
    expect(stats.candidateEvents).toBe(2);
    expect(stats.inserted).toBe(2);
    expect(values).toHaveBeenCalledTimes(1);
    const insertedRows = values.mock.calls[0]?.[0] as Array<{ dedupeKey: string }>;
    expect(insertedRows).toHaveLength(2);
  });

  it("E: ON CONFLICT path swallows duplicate-key conflicts (no throw)", async () => {
    const { upsertWalletLedgerEvents } = await loadModule();
    await expect(
      upsertWalletLedgerEvents("0xwallet", [event("only-one", 1)])
    ).resolves.toMatchObject({ inserted: 1, skippedExisting: 0 });
    expect(onConflictDoNothing).toHaveBeenCalled();
  });

  it("F: idempotent stats after simulated retry — counts stay stable", async () => {
    const { upsertWalletLedgerEvents } = await loadModule();
    const batch = [event("a", 1), event("b", 2)];
    const first = await upsertWalletLedgerEvents("0xwallet", batch);
    const second = await upsertWalletLedgerEvents("0xwallet", batch);
    expect(first).toMatchObject({ inserted: 2, skippedExisting: 0 });
    expect(second).toMatchObject({ inserted: 0, skippedExisting: 2 });
  });
});
