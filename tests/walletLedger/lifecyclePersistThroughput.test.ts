import { describe, expect, it } from "vitest";
import {
  LIFECYCLE_INSERT_VALUE_COLUMNS,
  LIFECYCLE_PERSIST_BATCH_SIZE,
  lifecycleInsertValues,
  planIncrementalLifecycleWrites,
  planLifecycleWriteBatches,
  positionToPersistedRow,
  type LifecycleWriteEntry,
  type PersistedLifecycleRow,
} from "@/lib/walletLedger/indexed/store/incrementalLifecycles";
import { WALLET_METRIC_VERSION } from "@/lib/walletLedger/indexed/metricVersion";
import { DbQueryTimeoutError } from "@/lib/walletLedger/indexed/store/dbQueryTimeout";
import { classifyExecutionOutcome } from "@/lib/walletLedger/indexed/shadow/infraClassification";
import type { PositionLifecycle } from "@/lib/walletLedger/types";

const WALLET = "0xbenchmarkwallet";

function position(index: number): PositionLifecycle {
  return {
    wallet: WALLET,
    conditionId: `cond-${index}`,
    asset: `asset-${index}`,
    lifecycleEpisode: 0,
    title: `Market ${index}`,
    outcome: "Yes",
    slug: null,
    events: [],
    grossBuyCash: 100 + index,
    grossSellCash: index % 3 === 0 ? 20 : 0,
    redeemCash: 0,
    netShares: 10,
    maxCumulativeCashOutlay: 100 + index,
    firstEntryAt: index,
    lastActivityAt: index + 1,
    fullyExited: index % 5 === 0,
    accountingStatus: index % 5 === 0 ? "closed" : "open",
    completed: index % 5 === 0,
    completionReason: index % 5 === 0 ? "fully_exited" : null,
    resolution: index % 7 === 0 ? { resolutionFinal: true, source: "gamma" } : null,
    resolutionPayoutUsd: index % 7 === 0 ? 5 : 0,
    realizedPnl: index % 5 === 0 ? 10 : null,
    capitalAtRisk: 100 + index,
    positionRoi: index % 5 === 0 ? 0.1 : null,
    heldThroughResolution: false,
    outcomeCorrect: index % 7 === 0 ? true : null,
    excludedFromMetrics: false,
    exclusionReason: null,
  };
}

function storedKey(walletAddress: string, row: PersistedLifecycleRow): string {
  return `${walletAddress}::${row.conditionId}::${row.assetId}::${WALLET_METRIC_VERSION}`;
}

function applyPerRowReference(
  store: Map<string, PersistedLifecycleRow>,
  walletAddress: string,
  entries: LifecycleWriteEntry[]
): number {
  let calls = 0;
  for (const entry of entries) {
    if (entry.action === "unchanged") continue;
    store.set(storedKey(walletAddress, entry.row), entry.row);
    calls += 1;
  }
  return calls;
}

function applyBatchedReference(
  store: Map<string, PersistedLifecycleRow>,
  walletAddress: string,
  entries: LifecycleWriteEntry[]
): number {
  const batches = planLifecycleWriteBatches(entries);
  let calls = 0;
  for (const batch of batches) {
    for (const entry of batch) {
      store.set(storedKey(walletAddress, entry.row), entry.row);
    }
    calls += 1;
  }
  return calls;
}

describe("lifecycle persistence throughput", () => {
  it("uses a safe multi-row batch size within Postgres parameter limits", () => {
    expect(LIFECYCLE_INSERT_VALUE_COLUMNS).toBe(20);
    expect(LIFECYCLE_PERSIST_BATCH_SIZE).toBeGreaterThanOrEqual(100);
    expect(LIFECYCLE_PERSIST_BATCH_SIZE).toBeLessThanOrEqual(250);
    expect(LIFECYCLE_INSERT_VALUE_COLUMNS * LIFECYCLE_PERSIST_BATCH_SIZE).toBeLessThan(
      65_535
    );
  });

  it("plans bounded batches for a 42,501-row full rebuild", () => {
    const positions = Array.from({ length: 42_501 }, (_, i) => position(i));
    const plan = planIncrementalLifecycleWrites({
      allPositions: positions,
      novelEvents: [],
      allEvents: [],
      persistedRows: [],
    });
    const batches = planLifecycleWriteBatches(plan.writes);
    expect(plan.writes).toHaveLength(42_501);
    expect(batches).toHaveLength(
      Math.ceil(42_501 / LIFECYCLE_PERSIST_BATCH_SIZE)
    );
    expect(batches.at(-1)?.length).toBe(
      42_501 % LIFECYCLE_PERSIST_BATCH_SIZE || LIFECYCLE_PERSIST_BATCH_SIZE
    );
  });

  it("produces identical stored rows for per-row vs batched reference upserts", () => {
    const positions = Array.from({ length: 5_000 }, (_, i) => position(i));
    const plan = planIncrementalLifecycleWrites({
      allPositions: positions,
      novelEvents: [],
      allEvents: [],
      persistedRows: [],
    });
    const walletAddress = WALLET.toLowerCase();
    const perRowStore = new Map<string, PersistedLifecycleRow>();
    const batchedStore = new Map<string, PersistedLifecycleRow>();
    const perRowCalls = applyPerRowReference(
      perRowStore,
      walletAddress,
      plan.writes
    );
    const batchedCalls = applyBatchedReference(
      batchedStore,
      walletAddress,
      plan.writes
    );
    expect(perRowCalls).toBe(5_000);
    expect(batchedCalls).toBe(Math.ceil(5_000 / LIFECYCLE_PERSIST_BATCH_SIZE));
    expect(batchedStore.size).toBe(perRowStore.size);
    for (const [key, row] of perRowStore) {
      expect(batchedStore.get(key)).toEqual(row);
    }
  });

  it("lifecycleInsertValues preserves exact column payload semantics", () => {
    const pos = position(42);
    const row = positionToPersistedRow(pos);
    const values = lifecycleInsertValues(WALLET.toLowerCase(), row);
    expect(values).toEqual({
      walletAddress: WALLET.toLowerCase(),
      conditionId: row.conditionId,
      assetId: row.assetId,
      metricVersion: WALLET_METRIC_VERSION,
      lifecycleEpisode: row.lifecycleEpisode,
      completed: row.completed,
      completionType: row.completionType,
      capitalAtRisk: row.capitalAtRisk,
      buyNotional: row.buyNotional,
      sellNotional: row.sellNotional,
      resolutionPayout: row.resolutionPayout,
      realizedPnl: row.realizedPnl,
      realizedRoi: row.realizedRoi,
      profitable: row.profitable,
      outcomeWin: row.outcomeWin,
      openedAt: row.openedAt,
      completedAt: row.completedAt,
      exclusionReason: row.exclusionReason,
      resolutionSource: row.resolutionSource,
      resolutionFinal: row.resolutionFinal,
    });
  });

  it("benchmarks simulated DB round-trips: batched is far fewer calls than per-row", () => {
    const total = 50_000;
    const perRowDelayMs = 1;
    const positions = Array.from({ length: total }, (_, i) => position(i));
    const plan = planIncrementalLifecycleWrites({
      allPositions: positions,
      novelEvents: [],
      allEvents: [],
      persistedRows: [],
    });

    const perRowCalls = plan.writes.filter((w) => w.action !== "unchanged").length;
    const batches = planLifecycleWriteBatches(plan.writes);
    const batchedCalls = batches.length;

    const perRowMs = perRowCalls * perRowDelayMs;
    const batchedMs = batchedCalls * perRowDelayMs;
    const batchedRowsPerSecond = total / (batchedMs / 1000);
    const expectedSecondsAtBatchedRate = total / batchedRowsPerSecond;

    expect(perRowCalls).toBe(total);
    expect(batchedCalls).toBe(Math.ceil(total / LIFECYCLE_PERSIST_BATCH_SIZE));
    expect(batchedMs).toBeLessThan(perRowMs / 10);
    expect(expectedSecondsAtBatchedRate).toBeLessThan(120);

    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        benchmark: "lifecycle-persist-simulated",
        totalLifecycles: total,
        perRowCalls,
        batchedCalls,
        perRowMs,
        batchedMs,
        batchedRowsPerSecond: Math.round(batchedRowsPerSecond),
        expectedSecondsFor50k: Math.round(expectedSecondsAtBatchedRate),
      })
    );
  });

  it("resumes interrupted incremental persist by inserting missing lifecycle rows", () => {
    const positions = Array.from({ length: 100 }, (_, i) =>
      position(i)
    );
    const persistedRows = positions.slice(0, 40).map(positionToPersistedRow);
    const plan = planIncrementalLifecycleWrites({
      allPositions: positions,
      novelEvents: [],
      allEvents: [],
      persistedRows,
    });
    expect(plan.lifecycleMode).toBe("incremental");
    expect(plan.writes.filter((w) => w.action === "insert")).toHaveLength(60);
    expect(plan.writes.filter((w) => w.action !== "unchanged")).toHaveLength(60);
  });

  it("classifies DbQueryTimeoutError as deferred_infra", () => {
    const error = new DbQueryTimeoutError("upsertLifecycleWriteBatch", 120_000);
    expect(classifyExecutionOutcome(error)).toBe("deferred_infra");
  });
});
