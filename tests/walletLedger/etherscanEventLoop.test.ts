import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHECKPOINT_APPEND_YIELD_EVERY,
  CheckpointLogSession,
  readCheckpointManifest,
} from "@/lib/walletLedger/indexed/checkpointLogStore";
import { CHECKPOINT_SCHEMA_VERSION } from "@/lib/walletLedger/indexed/checkpoint";
import { QUERY_PLAN_VERSION } from "@/lib/walletLedger/indexed/checkpoint";
import {
  EtherscanPhaseMetricsCollector,
  setActiveEtherscanPhaseMetricsCollector,
} from "@/lib/walletLedger/indexed/etherscanPhaseMetrics";
import { EventLoopDelayMonitor } from "@/lib/walletLedger/indexed/eventLoopMonitor";
import { EtherscanQueryController } from "@/lib/walletLedger/indexed/etherscanQueryController";
import type { RpcLog } from "@/lib/walletLedger/onchain/types";

function sampleLog(index: number): RpcLog {
  return {
    address: "0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e",
    topics: ["0xabc"],
    data: "0x",
    blockNumber: "0x1",
    transactionHash: `0x${index.toString(16).padStart(64, "0")}`,
    logIndex: "0x0",
    blockHash: "0xdef",
    transactionIndex: "0x0",
    removed: false,
  };
}

describe("event loop starvation hardening", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    setActiveEtherscanPhaseMetricsCollector(null);
    vi.useRealTimers();
  });

  it("watchdog blind spot: timer watchdog cannot fire during synchronous CPU block", () => {
    vi.useRealTimers();
    const controller = new EtherscanQueryController({
      wallet: "0xabc",
      queryIndex: 1,
      queryTotal: 1,
      queryLabel: "sync-block",
      rangeFrom: 1,
      rangeTo: 2,
      noProgressTimeoutMs: 50,
    });
    controller.start();
    controller.markProgress("page_processed", { requests: 1, pages: 1 });
    const blockStarted = Date.now();
    while (Date.now() - blockStarted < 120) {
      // deliberate event-loop starvation
    }
    expect(() => controller.throwIfAborted()).not.toThrow();
    controller.stop();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  it("bounded appendLogsAsync yields so event-loop delay stays below 30s", async () => {
    vi.useRealTimers();
    const key = `yield-test-${Date.now()}`;
    const session = CheckpointLogSession.create({
      key,
      checkpointVersion: CHECKPOINT_SCHEMA_VERSION,
      queryPlanVersion: QUERY_PLAN_VERSION,
      identity: {
        providerId: "etherscan_v2",
        chainId: "137",
        wallet: "0xabc",
        contract: "0xcontract",
        stableFromBlock: 1,
        topics: [],
      },
    });
    const collector = new EtherscanPhaseMetricsCollector();
    collector.beginWallet("0xabc");
    collector.beginQuery(1);
    setActiveEtherscanPhaseMetricsCollector(collector);

    const monitor = new EventLoopDelayMonitor();
    monitor.start();
    const logs = Array.from({ length: 500 }, (_, i) => sampleLog(i));
    const heartbeat = setInterval(() => {
      monitor.snapshot();
    }, 10);
    await session.appendLogsAsync(logs);
    session.flush();
    clearInterval(heartbeat);
    const snap = monitor.snapshot();
    monitor.stop();

    expect(snap.eventLoopDelayMaxMs).toBeLessThan(30_000);
    const metrics = collector.getQueryMetrics(1);
    expect(metrics?.maxAppendMs ?? 0).toBeGreaterThan(0);
    expect(readCheckpointManifest(key)?.logCount).toBe(logs.length);
  });
});
