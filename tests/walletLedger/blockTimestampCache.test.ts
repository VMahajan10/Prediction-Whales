import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearBlockTimestampCache,
  readBlockTimestampStore,
  resolveBlockTimestamps,
  seedBlockTimestampsFromLogs,
  setBlockTimestampCacheDirForTests,
  POLYGON_CHAIN_ID,
} from "@/lib/walletLedger/indexed/blockTimestampCache";
import { PolygonRpcClient } from "@/lib/walletLedger/onchain/rpc";
import type { RpcLog } from "@/lib/walletLedger/onchain/types";

let testCacheDir: string;

function sampleLog(block: number, ts?: number): RpcLog {
  return {
    address: "0xabc",
    topics: [],
    data: "0x",
    blockNumber: `0x${block.toString(16)}`,
    transactionHash: "0x1",
    logIndex: "0x0",
    blockTimestamp: ts,
  };
}

function mockRpc(
  impl: (block: number) => number | null
): PolygonRpcClient {
  const rpc = new PolygonRpcClient({ rpcUrls: ["http://localhost:0"], maxRetries: 0 });
  vi.spyOn(rpc, "getBlockTimestamp").mockImplementation(async (block) => impl(block));
  return rpc;
}

describe("block timestamp cache", () => {
  beforeEach(() => {
    testCacheDir = mkdtempSync(join(tmpdir(), "block-ts-cache-"));
    setBlockTimestampCacheDirForTests(testCacheDir);
  });

  afterEach(() => {
    setBlockTimestampCacheDirForTests(null);
    rmSync(testCacheDir, { recursive: true, force: true });
  });

  it("A: 70k cached blocks → 70k hits, zero RPC lookups", async () => {
    const store: Record<string, number> = {};
    for (let i = 1; i <= 70_000; i += 1) {
      store[String(i)] = 1_700_000_000 + i;
    }
    mkdirSync(testCacheDir, { recursive: true });
    writeFileSync(
      join(testCacheDir, `chain-${POLYGON_CHAIN_ID}.json`),
      JSON.stringify(store)
    );

    const rpc = mockRpc(() => 999);
    const blocks = Array.from({ length: 70_000 }, (_, i) => i + 1);
    const { stats } = await resolveBlockTimestamps(blocks, rpc);

    expect(stats.requestedUnique).toBe(70_000);
    expect(stats.diskEntriesLoaded).toBe(70_000);
    expect(stats.hits).toBe(70_000);
    expect(stats.misses).toBe(0);
    expect(stats.logicalRpcLookups).toBe(0);
    expect(stats.rpcAttempts).toBe(0);
  });

  it("B: 70k cached + 1k new blocks → 70k hits and 1k logical RPC lookups", async () => {
    const store: Record<string, number> = {};
    for (let i = 1; i <= 70_000; i += 1) {
      store[String(i)] = 1_700_000_000 + i;
    }
    writeFileSync(
      join(testCacheDir, `chain-${POLYGON_CHAIN_ID}.json`),
      JSON.stringify(store)
    );

    const rpc = mockRpc((block) => 1_800_000_000 + block);
    const blocks = [
      ...Array.from({ length: 70_000 }, (_, i) => i + 1),
      ...Array.from({ length: 1_000 }, (_, i) => 70_000 + i + 1),
    ];
    const { stats } = await resolveBlockTimestamps(blocks, rpc);

    expect(stats.hits).toBe(70_000);
    expect(stats.misses).toBe(1_000);
    expect(stats.logicalRpcLookups).toBe(1_000);
    expect(stats.successes).toBe(1_000);
    expect(stats.persistedEntries).toBe(71_000);
  });

  it("C: duplicate events from same block → exactly one timestamp lookup", async () => {
    const rpc = mockRpc((block) => 1_700_000_000 + block);
    const dupes = Array.from({ length: 100 }, () => 42);
    const { stats } = await resolveBlockTimestamps(dupes, rpc);
    expect(stats.requestedUnique).toBe(1);
    expect(stats.logicalRpcLookups).toBe(1);
  });

  it("D: concurrent requests for same missing block → one actual RPC lookup", async () => {
    let calls = 0;
    const rpc = mockRpc((block) => {
      calls += 1;
      return 1_700_000_000 + block;
    });

    const [a, b] = await Promise.all([
      resolveBlockTimestamps([999], rpc),
      resolveBlockTimestamps([999], rpc),
    ]);

    expect(calls).toBe(1);
    expect(a.stats.logicalRpcLookups + b.stats.logicalRpcLookups).toBe(1);
    expect(a.stats.inFlightReused + b.stats.inFlightReused).toBe(1);
  });

  it("E: persisted cache reload preserves every entry", async () => {
    const rpc = mockRpc((block) => 1_700_000_000 + block);
    await resolveBlockTimestamps([10, 11, 12], rpc);
    const reloaded = readBlockTimestampStore(POLYGON_CHAIN_ID);
    expect(Object.keys(reloaded)).toEqual(["10", "11", "12"]);
    expect(reloaded["10"]).toBe(1_700_000_010);
  });

  it("F: second run after cold populate → near-100% cache hit rate", async () => {
    const rpc = mockRpc((block) => 1_700_000_000 + block);
    const blocks = [100, 101, 102, 103];
    const cold = await resolveBlockTimestamps(blocks, rpc);
    expect(cold.stats.misses).toBe(4);

    const warm = await resolveBlockTimestamps(blocks, rpc);
    expect(warm.stats.hits).toBe(4);
    expect(warm.stats.misses).toBe(0);
    expect(warm.stats.logicalRpcLookups).toBe(0);
  });

  it("seeds timestamps from etherscan log rows before RPC", async () => {
    const rpc = mockRpc(() => 999);
    const getSpy = vi.spyOn(rpc, "getBlockTimestamp");

    const { timestamps, stats } = await resolveBlockTimestamps([100, 101], rpc, {
      logSeeds: [sampleLog(100, 1_700_000_000), sampleLog(101, 1_700_000_100)],
    });

    expect(timestamps.get(100)).toBe(1_700_000_000);
    expect(timestamps.get(101)).toBe(1_700_000_100);
    expect(stats.logSeededUnique).toBe(2);
    expect(stats.misses).toBe(0);
    expect(getSpy).not.toHaveBeenCalled();
  });

  it("deduplicates block numbers before fetch in log seeding", () => {
    const store: Record<string, number> = {};
    const seeded = seedBlockTimestampsFromLogs(
      [sampleLog(50, 100), sampleLog(50, 200)],
      store
    );
    expect(seeded.seededUnique).toBe(1);
    expect(store["50"]).toBe(100);
  });

  it("atomic merge does not drop existing entries on partial write", async () => {
    writeFileSync(
      join(testCacheDir, `chain-${POLYGON_CHAIN_ID}.json`),
      JSON.stringify({ "1": 100, "2": 200 })
    );
    const rpc = mockRpc((block) => 300 + block);
    await resolveBlockTimestamps([3], rpc);
    const store = readBlockTimestampStore(POLYGON_CHAIN_ID);
    expect(store["1"]).toBe(100);
    expect(store["2"]).toBe(200);
    expect(store["3"]).toBe(303);
  });
});
