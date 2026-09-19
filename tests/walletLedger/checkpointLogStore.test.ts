import { existsSync, readFileSync, rmSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CHECKPOINT_LOG_CHUNK_LINES,
  CHECKPOINT_STORE_DIR,
  CheckpointLogSession,
  checkpointStoreDir,
  readCheckpointManifest,
  readLogsFromStore,
  rpcLogDedupeKey,
  chunkPath,
} from "@/lib/walletLedger/indexed/checkpointLogStore";
import {
  CHECKPOINT_SCHEMA_VERSION,
  QUERY_PLAN_VERSION,
  buildQueryCheckpointKey,
} from "@/lib/walletLedger/indexed/checkpoint";
import {
  CTF_EXCHANGE_V1_ADDRESS,
  POLYMARKET_EXCHANGE_INITIAL_BLOCK,
  TOPIC_ORDER_FILLED_V1,
} from "@/lib/walletLedger/onchain/contracts";
import { walletTopic } from "@/lib/walletLedger/onchain/rpc";
import type { RpcLog } from "@/lib/walletLedger/onchain/types";

const WALLET = "0x0562e01b3c3e65bb93bf0de32f02cec238a79d66";

function makeLog(i: number): RpcLog {
  return {
    address: CTF_EXCHANGE_V1_ADDRESS,
    topics: [TOPIC_ORDER_FILLED_V1],
    data: "0x",
    blockNumber: `0x${(1_000_000 + (i % 10_000)).toString(16)}`,
    transactionHash: `0x${i.toString(16).padStart(64, "0")}`,
    logIndex: "0x0",
    blockHash: "0x" + "11".repeat(32),
    transactionIndex: "0x0",
    removed: false,
  };
}

describe("checkpoint log store", () => {
  it("appends and dedupes across flush cycles", () => {
    const key = buildQueryCheckpointKey({
      providerId: "etherscan_v2",
      chainId: "137",
      wallet: WALLET,
      contract: CTF_EXCHANGE_V1_ADDRESS,
      stableFromBlock: POLYMARKET_EXCHANGE_INITIAL_BLOCK,
      topics: [TOPIC_ORDER_FILLED_V1, null, walletTopic(WALLET)],
    });
    const storeDir = checkpointStoreDir(key);
    if (existsSync(storeDir)) rmSync(storeDir, { recursive: true, force: true });

    const session = CheckpointLogSession.create({
      key,
      checkpointVersion: CHECKPOINT_SCHEMA_VERSION,
      queryPlanVersion: QUERY_PLAN_VERSION,
      identity: {
        providerId: "etherscan_v2",
        chainId: "137",
        wallet: WALLET,
        contract: CTF_EXCHANGE_V1_ADDRESS,
        stableFromBlock: POLYMARKET_EXCHANGE_INITIAL_BLOCK,
        topics: [TOPIC_ORDER_FILLED_V1, null, walletTopic(WALLET)],
      },
    });

    const batch1 = [makeLog(1), makeLog(2)];
    const batch2 = [makeLog(2), makeLog(3)];
    expect(session.appendLogs(batch1)).toBe(2);
    session.flush();
    expect(session.appendLogs(batch2)).toBe(1);
    session.flush();

    const manifest = readCheckpointManifest(key);
    expect(manifest?.logCount).toBe(3);
    const loaded = readLogsFromStore(key);
    expect(loaded).toHaveLength(3);
    expect(new Set(loaded.map(rpcLogDedupeKey)).size).toBe(3);

    rmSync(storeDir, { recursive: true, force: true });
  });

  it(
    "stores 500k synthetic logs without Invalid string length",
    () => {
    const key = buildQueryCheckpointKey({
      providerId: "etherscan_v2",
      chainId: "137",
      wallet: "0xdc41c39b95453c943174f369926018f6963bdd7e",
      contract: CTF_EXCHANGE_V1_ADDRESS,
      stableFromBlock: POLYMARKET_EXCHANGE_INITIAL_BLOCK,
      topics: [TOPIC_ORDER_FILLED_V1, null, walletTopic(WALLET)],
    });
    const storeDir = checkpointStoreDir(key);
    if (existsSync(storeDir)) rmSync(storeDir, { recursive: true, force: true });

    const session = CheckpointLogSession.create({
      key,
      checkpointVersion: CHECKPOINT_SCHEMA_VERSION,
      queryPlanVersion: QUERY_PLAN_VERSION,
      identity: {
        providerId: "etherscan_v2",
        chainId: "137",
        wallet: "0xdc41c39b95453c943174f369926018f6963bdd7e",
        contract: CTF_EXCHANGE_V1_ADDRESS,
        stableFromBlock: POLYMARKET_EXCHANGE_INITIAL_BLOCK,
        topics: [TOPIC_ORDER_FILLED_V1, null, walletTopic(WALLET)],
      },
    });

    const chunkSize = 5_000;
    for (let offset = 0; offset < 500_000; offset += chunkSize) {
      const batch = Array.from({ length: chunkSize }, (_, i) => makeLog(offset + i));
      session.appendLogs(batch);
      if (offset % 50_000 === 0) session.flush();
    }
    session.flush();

    const manifest = readCheckpointManifest(key);
    expect(manifest?.logCount).toBe(500_000);
    expect(manifest!.logChunkCount).toBeGreaterThanOrEqual(
      Math.ceil(500_000 / CHECKPOINT_LOG_CHUNK_LINES)
    );

    const firstChunkLines = readFileSync(chunkPath(key, 1), "utf8")
      .split("\n")
      .filter((line) => line.trim());
    expect(firstChunkLines.length).toBeGreaterThan(0);
    expect((JSON.parse(firstChunkLines[0]!) as RpcLog).transactionHash).toBeTruthy();

    rmSync(storeDir, { recursive: true, force: true });
    },
    120_000
  );
});
