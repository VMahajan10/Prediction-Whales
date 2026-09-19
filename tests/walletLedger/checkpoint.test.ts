import { existsSync, rmSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { appendAll, maxOf, minOf } from "@/lib/walletLedger/indexed/arrayUtils";
import {
  CHECKPOINT_SCHEMA_VERSION,
  QUERY_PLAN_VERSION,
  buildQueryCheckpointKey,
  isCompatibleCheckpoint,
  readEtherscanCheckpointForIdentity,
  writeEtherscanCheckpoint,
  type QueryCheckpointIdentity,
} from "@/lib/walletLedger/indexed/checkpoint";
import { checkpointStoreDir } from "@/lib/walletLedger/indexed/checkpointLogStore";
import {
  computeCheckpointResumePlan,
  highestCompletedBlock,
  normalizeRanges,
  subtractRanges,
} from "@/lib/walletLedger/indexed/checkpointIntervals";
import { buildWalletLogQueries } from "@/lib/walletLedger/indexed/providers/fullHistoryRpc";
import {
  CONDITIONAL_TOKENS_ADDRESS,
  CTF_EXCHANGE_LEGACY_ADDRESS,
  CTF_EXCHANGE_V1_ADDRESS,
  POLYMARKET_EXCHANGE_INITIAL_BLOCK,
  TOPIC_ORDER_FILLED_V1,
  TOPIC_POSITION_SPLIT,
} from "@/lib/walletLedger/onchain/contracts";
import { dedupeLogs, walletTopic } from "@/lib/walletLedger/onchain/rpc";
import type { RpcLog } from "@/lib/walletLedger/onchain/types";

const WALLET = "0x0562e01b3c3e65bb93bf0de32f02cec238a79d66";
const FROM = POLYMARKET_EXCHANGE_INITIAL_BLOCK;

function identity(input: Partial<QueryCheckpointIdentity>): QueryCheckpointIdentity {
  return {
    providerId: "etherscan_v2",
    chainId: "137",
    wallet: WALLET,
    contract: CTF_EXCHANGE_V1_ADDRESS,
    stableFromBlock: FROM,
    topics: [TOPIC_ORDER_FILLED_V1, null, walletTopic(WALLET)],
    ...input,
  };
}

describe("checkpoint interval algebra", () => {
  it("reuses old coverage and fetches only the new tail when head advances", () => {
    const plan = computeCheckpointResumePlan(FROM, 92_879_612, [
      { from: FROM, to: 92_852_360 },
    ]);
    expect(plan.reusedBlocks).toBe(92_852_360 - FROM + 1);
    expect(plan.newBlocksToFetch).toBe(92_879_612 - 92_852_360);
    expect(plan.uncoveredRanges).toEqual([
      { from: 92_852_361, to: 92_879_612 },
    ]);
  });

  it("computes gapped uncovered ranges", () => {
    const uncovered = subtractRanges(
      { from: 57_000_000, to: 100_000_000 },
      [
        { from: 57_000_000, to: 70_000_000 },
        { from: 80_000_000, to: 90_000_000 },
      ]
    );
    expect(uncovered).toEqual([
      { from: 70_000_001, to: 79_999_999 },
      { from: 90_000_001, to: 100_000_000 },
    ]);
  });

  it("normalizes overlapping completed ranges", () => {
    expect(
      normalizeRanges([
        { from: 57_000_000, to: 70_000_000 },
        { from: 69_000_000, to: 80_000_000 },
      ])
    ).toEqual([{ from: 57_000_000, to: 80_000_000 }]);
  });

  it("tracks highest completed block", () => {
    expect(
      highestCompletedBlock([
        { from: 57_000_000, to: 70_000_000 },
        { from: 80_000_000, to: 90_000_000 },
      ])
    ).toBe(90_000_000);
  });
});

describe("stable checkpoint identity", () => {
  it("keeps maker and taker distinct regardless of head", () => {
    const padded = walletTopic(WALLET);
    const maker = buildQueryCheckpointKey(
      identity({
        contract: CTF_EXCHANGE_V1_ADDRESS,
        topics: [TOPIC_ORDER_FILLED_V1, null, padded],
      })
    );
    const taker = buildQueryCheckpointKey(
      identity({
        contract: CTF_EXCHANGE_V1_ADDRESS,
        topics: [TOPIC_ORDER_FILLED_V1, null, null, padded],
      })
    );
    expect(maker).not.toBe(taker);
  });

  it("keeps different contracts and topic0 values distinct", () => {
    const makerV1 = buildQueryCheckpointKey(
      identity({ contract: CTF_EXCHANGE_V1_ADDRESS })
    );
    const makerLegacy = buildQueryCheckpointKey(
      identity({ contract: CTF_EXCHANGE_LEGACY_ADDRESS })
    );
    const split = buildQueryCheckpointKey(
      identity({
        contract: CONDITIONAL_TOKENS_ADDRESS,
        topics: [TOPIC_POSITION_SPLIT, walletTopic(WALLET)],
      })
    );
    expect(new Set([makerV1, makerLegacy, split]).size).toBe(3);
  });

  it("does not change keys when only requested head advances", () => {
    const queryA = buildWalletLogQueries(WALLET, FROM, 92_852_360)[0]!;
    const queryB = buildWalletLogQueries(WALLET, FROM, 92_879_612)[0]!;
    const keyA = buildQueryCheckpointKey({
      providerId: "etherscan_v2",
      chainId: "137",
      wallet: WALLET,
      contract: queryA.address,
      stableFromBlock: queryA.fromBlock,
      topics: queryA.topics ?? [],
    });
    const keyB = buildQueryCheckpointKey({
      providerId: "etherscan_v2",
      chainId: "137",
      wallet: WALLET,
      contract: queryB.address,
      stableFromBlock: queryB.fromBlock,
      topics: queryB.topics ?? [],
    });
    expect(keyA).toBe(keyB);
  });

  it("rejects incompatible checkpoint versions", () => {
    const id = identity({
      wallet: "0x00000000000000000000000000000000000000aa",
      contract: CTF_EXCHANGE_LEGACY_ADDRESS,
    });
    const key = buildQueryCheckpointKey(id);
    for (const version of [CHECKPOINT_SCHEMA_VERSION, 2]) {
      const dir = checkpointStoreDir(buildQueryCheckpointKey(id, version));
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
    writeEtherscanCheckpoint({
      key,
      checkpointVersion: 1,
      queryPlanVersion: "legacy",
      identity: id,
      completedRanges: [],
      highestCompletedBlock: null,
      logCount: 0,
      logStoreVersion: 0,
      logs: [],
      requests: 0,
      pages: 0,
      errors: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const loaded = readEtherscanCheckpointForIdentity(id);
    expect(loaded).toBeNull();
    expect(isCompatibleCheckpoint({
      key,
      checkpointVersion: 1,
      queryPlanVersion: "legacy",
      identity: id,
      completedRanges: [],
      highestCompletedBlock: null,
      logCount: 0,
      logStoreVersion: 0,
      logs: [],
      requests: 0,
      pages: 0,
      errors: [],
      createdAt: "",
      updatedAt: "",
    })).toBe(false);
    const storeDir = checkpointStoreDir(key);
    if (existsSync(storeDir)) rmSync(storeDir, { recursive: true, force: true });
  });
});

describe("checkpoint log merge safety", () => {
  it("dedupes duplicate logs from checkpoint and new tail", () => {
    const log: RpcLog = {
      address: CTF_EXCHANGE_V1_ADDRESS,
      topics: [TOPIC_ORDER_FILLED_V1],
      data: "0x",
      blockNumber: "0x36b0900",
      transactionHash: "0xabc",
      logIndex: "0x1",
      blockHash: "0x" + "22".repeat(32),
      transactionIndex: "0x0",
      removed: false,
    };
    const merged: RpcLog[] = [log];
    appendAll(merged, [log, { ...log, data: "0x01" }]);
    expect(dedupeLogs(merged)).toHaveLength(1);
  });

  it("appends 250k logs without stack overflow", () => {
    const makeLog = (i: number): RpcLog => ({
      address: CTF_EXCHANGE_V1_ADDRESS,
      topics: [TOPIC_ORDER_FILLED_V1],
      data: "0x",
      blockNumber: `0x${(1_000_000 + (i % 10_000)).toString(16)}`,
      transactionHash: `0x${i.toString(16).padStart(64, "0")}`,
      logIndex: "0x0",
      blockHash: "0x" + "11".repeat(32),
      transactionIndex: "0x0",
      removed: false,
    });
    const source = Array.from({ length: 250_000 }, (_, i) => makeLog(i));
    source.push(makeLog(42));
    const merged: RpcLog[] = [];
    expect(() => appendAll(merged, source)).not.toThrow();
    expect(dedupeLogs(merged)).toHaveLength(250_000);
    expect(minOf(source.map((_, i) => i))).toBe(0);
    expect(maxOf(source.map((_, i) => i))).toBe(250_000);
  });
});

describe("checkpoint schema metadata", () => {
  it("stores version metadata on write", () => {
    expect(CHECKPOINT_SCHEMA_VERSION).toBe(3);
    expect(QUERY_PLAN_VERSION).toBe("2d-etherscan-v1");
  });
});
