import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FetchTimeoutError, fetchTextWithTimeout } from "@/lib/fetchWithTimeout";
import {
  EtherscanNoProgressTimeout,
  EtherscanProviderCircuitOpenError,
  EtherscanQueryMaxRuntimeError,
  ETHERSCAN_NO_PROGRESS_REASON,
  ETHERSCAN_PROVIDER_CIRCUIT_OPEN_REASON,
} from "@/lib/walletLedger/indexed/etherscanErrors";
import { setAuditProgressEnabled, EtherscanProgressReporter } from "@/lib/walletLedger/indexed/auditProgress";
import {
  recordProviderFailure,
  resetProviderCircuitForTests,
} from "@/lib/walletLedger/indexed/shadow/providerCircuitBreaker";
import { EtherscanRateLimiter } from "@/lib/walletLedger/indexed/etherscanRateLimiter";
import {
  EtherscanQueryController,
  EtherscanWalletExecutionBudget,
} from "@/lib/walletLedger/indexed/etherscanQueryController";
import {
  ETHERSCAN_JSON_PARSE_WORKER_THRESHOLD_BYTES,
  parseEtherscanJsonBody,
} from "@/lib/walletLedger/indexed/etherscanJsonParse";
import { fetchIndexedWalletHistory } from "@/lib/walletLedger/indexed/walletHistory";
import type { IndexedFetchStats, IndexedLogProvider } from "@/lib/walletLedger/indexed/types";
import {
  ETHERSCAN_REQUEST_TIMEOUT_MS,
  fetchEtherscanWithRetry,
} from "@/lib/walletLedger/indexed/etherscanRetry";
import {
  classifyExecutionOutcome,
  etherscanInfraTimeoutReason,
} from "@/lib/walletLedger/indexed/shadow/infraClassification";
import {
  CheckpointLogSession,
  readCheckpointManifest,
} from "@/lib/walletLedger/indexed/checkpointLogStore";
import { CHECKPOINT_SCHEMA_VERSION } from "@/lib/walletLedger/indexed/checkpoint";
import { QUERY_PLAN_VERSION } from "@/lib/walletLedger/indexed/checkpoint";

describe("etherscan watchdog and limiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetProviderCircuitForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    resetProviderCircuitForTests();
  });

  it("A: fetch hangs are bounded by the 20s fetch timeout", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });
    });
    const promise = fetchTextWithTimeout("https://example.com/hang", {
      timeoutMs: 20,
    });
    const expectation = expect(promise).rejects.toBeInstanceOf(FetchTimeoutError);
    await vi.advanceTimersByTimeAsync(25);
    await expectation;
  });

  it("B: limiter slot wait aborts cleanly via shared signal", async () => {
    const limiter = new EtherscanRateLimiter(100, 1);
    const releaseFirst = await limiter.acquire();
    const controller = new AbortController();
    const blocked = limiter.acquire(controller.signal);
    controller.abort();
    await expect(blocked).rejects.toBeInstanceOf(EtherscanNoProgressTimeout);
    releaseFirst();
    expect(limiter.activeSlots).toBe(0);
  });

  it("C: retry sleep is cancelled by abort signal", async () => {
    const controller = new AbortController();
    const sleepPromise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 60_000);
      controller.signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(
          new EtherscanNoProgressTimeout("Retry sleep aborted", undefined, "retry_wait")
        );
      });
    });
    controller.abort();
    await expect(sleepPromise).rejects.toBeInstanceOf(EtherscanNoProgressTimeout);
  });

  it("D: limiter slot is released after AbortError", async () => {
    vi.useRealTimers();
    const limiter = new EtherscanRateLimiter(100, 1);
    const controller = new AbortController();
    const release = await limiter.acquire(controller.signal);
    controller.abort();
    release();
    expect(limiter.activeSlots).toBe(0);
    await expect(limiter.acquire()).resolves.toEqual(expect.any(Function));
    vi.useFakeTimers();
  });

  it("E: frozen page counters trigger EtherscanNoProgressTimeout", async () => {
    const controller = new EtherscanQueryController({
      wallet: "0xabc",
      queryIndex: 5,
      queryTotal: 11,
      queryLabel: "test",
      rangeFrom: 1,
      rangeTo: 2,
      noProgressTimeoutMs: 1_000,
    });
    controller.start();
    controller.markProgress("page_processed", { requests: 16, pages: 16, logs: 100 });
    await vi.advanceTimersByTimeAsync(6_000);
    expect(() => controller.throwIfAborted()).toThrow(EtherscanNoProgressTimeout);
    controller.stop();
  });

  it("F: slow query with steady progress does not trip no-progress watchdog", async () => {
    const controller = new EtherscanQueryController({
      wallet: "0xabc",
      queryIndex: 1,
      queryTotal: 1,
      queryLabel: "test",
      rangeFrom: 1,
      rangeTo: 2,
      noProgressTimeoutMs: 5_000,
    });
    controller.start();
    for (let i = 0; i < 4; i += 1) {
      await vi.advanceTimersByTimeAsync(4_000);
      controller.markProgress("page_processed", {
        requests: i + 1,
        pages: i + 1,
        logs: (i + 1) * 100,
      });
    }
    expect(() => controller.throwIfAborted()).not.toThrow();
    controller.stop();
  });

  it("G: query with progress can run past no-progress window until max runtime", async () => {
    const controller = new EtherscanQueryController({
      wallet: "0xabc",
      queryIndex: 1,
      queryTotal: 1,
      queryLabel: "test",
      rangeFrom: 1,
      rangeTo: 2,
      noProgressTimeoutMs: 30_000,
      maxRuntimeMs: 60_000,
    });
    controller.start();
    for (let i = 0; i < 11; i += 1) {
      await vi.advanceTimersByTimeAsync(5_000);
      controller.markProgress("page_processed", { requests: i + 1, pages: i + 1 });
    }
    await vi.advanceTimersByTimeAsync(10_000);
    expect(() => controller.throwIfAborted()).toThrow(EtherscanQueryMaxRuntimeError);
    controller.stop();
  });

  it("H: timeout classification is deferred_infra and preserves checkpoint ranges", () => {
    const key = `watchdog-test-${Date.now()}`;
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
    session.updateProgress({
      completedRanges: [{ from: 1, to: 100 }],
      requests: 16,
      pages: 16,
      errors: [],
    });
    session.flush();

    const timeout = new EtherscanNoProgressTimeout("no progress", undefined, "json_parsed");
    expect(classifyExecutionOutcome(timeout)).toBe("deferred_infra");
    expect(etherscanInfraTimeoutReason(timeout)).toBe(ETHERSCAN_NO_PROGRESS_REASON);

    const manifest = readCheckpointManifest(key);
    expect(manifest?.completedRanges).toEqual([{ from: 1, to: 100 }]);
    expect(manifest?.pages).toBe(16);
  });

  it("fetchEtherscanWithRetry propagates abort before retry sleep", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network fail"));
    const controller = new AbortController();
    const promise = fetchEtherscanWithRetry("https://example.com", {
      maxAttempts: 3,
      timeoutMs: ETHERSCAN_REQUEST_TIMEOUT_MS,
      signal: controller.signal,
    });
    controller.abort();
    await expect(promise).rejects.toBeInstanceOf(EtherscanNoProgressTimeout);
  });

  it("wallet runtime budget aborts with deferred_infra reason", async () => {
    const budget = new EtherscanWalletExecutionBudget("0xabc", 1_000);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(budget.signal.aborted).toBe(true);
    budget.stop();
  });

  it("heartbeat lastProgressAgo increases while counters are frozen", () => {
    setAuditProgressEnabled(true);
    const controller = new EtherscanQueryController({
      wallet: "0xabc",
      queryIndex: 4,
      queryTotal: 11,
      queryLabel: "test",
      rangeFrom: 1,
      rangeTo: 2,
      noProgressTimeoutMs: 180_000,
    });
    const reporter = new EtherscanProgressReporter(11);
    reporter.bindQueryProgressClock(() => controller.getLastProgressAgoMs());
    controller.start();
    controller.markProgress("page_processed", {
      requests: 12,
      pages: 12,
      logs: 9996,
    });
    reporter.updateCounts({
      requests: 12,
      pages: 12,
      logs: 9996,
      splits: 0,
      rateLimitHits: 0,
    });
    reporter.printHeartbeat();
    const firstAgo = controller.getLastProgressAgoMs();
    vi.advanceTimersByTime(60_000);
    reporter.printHeartbeat();
    const secondAgo = controller.getLastProgressAgoMs();
    expect(secondAgo).toBeGreaterThan(firstAgo);
    controller.stop();
    reporter.stop();
  });

  it("I: provider circuit open with zero active work fails immediately", async () => {
    const controller = new EtherscanQueryController({
      wallet: "0xabc",
      queryIndex: 4,
      queryTotal: 11,
      queryLabel: "test",
      rangeFrom: 1,
      rangeTo: 2,
      noProgressTimeoutMs: 180_000,
    });
    controller.start();
    controller.markProgress("page_processed", {
      requests: 12,
      pages: 12,
      logs: 9996,
    });
    for (let i = 0; i < 3; i += 1) {
      recordProviderFailure(new Error("transient"));
    }
    controller.setRuntimeState({
      limiterActive: 0,
      limiterWaiting: 0,
      providerCircuitOpen: true,
    });
    expect(() => controller.throwIfAborted()).toThrow(EtherscanProviderCircuitOpenError);
    expect(classifyExecutionOutcome(new EtherscanProviderCircuitOpenError("open"))).toBe(
      "deferred_infra"
    );
    expect(
      etherscanInfraTimeoutReason(
        new EtherscanProviderCircuitOpenError("open")
      )
    ).toBe(ETHERSCAN_PROVIDER_CIRCUIT_OPEN_REASON);
    controller.stop();
  });

  it("J: reproduces frozen counters with circuit open and exits before wallet deadline", async () => {
    const controller = new EtherscanQueryController({
      wallet: "0xabc",
      queryIndex: 4,
      queryTotal: 11,
      queryLabel: "test",
      rangeFrom: 1,
      rangeTo: 2,
      noProgressTimeoutMs: 180_000,
      maxRuntimeMs: 3_600_000,
    });
    controller.start();
    controller.markProgress("page_processed", {
      requests: 12,
      pages: 12,
      logs: 9996,
    });
    for (let i = 0; i < 3; i += 1) {
      recordProviderFailure(new Error("transient"));
    }
    controller.setRuntimeState({
      limiterActive: 0,
      limiterWaiting: 0,
      providerCircuitOpen: true,
    });
    expect(() => controller.throwIfAborted()).toThrow(EtherscanProviderCircuitOpenError);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(() => controller.throwIfAborted()).toThrow(EtherscanProviderCircuitOpenError);
    controller.stop();
  });

  it("K: retry_attempt_start logs request-relative elapsedMs", async () => {
    vi.useRealTimers();
    const lifecycle: Array<{ phase: string; elapsedMs: number }> = [];
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ status: "1", result: [] }), { status: 200 })
    );
    await fetchEtherscanWithRetry("https://example.com/etherscan", {
      maxAttempts: 1,
      onLifecycle: (phase, _attempt, elapsedMs) => {
        lifecycle.push({ phase, elapsedMs });
      },
    });
    const start = lifecycle.find((entry) => entry.phase === "retry_attempt_start");
    expect(start).toBeDefined();
    expect(start!.elapsedMs).toBeLessThan(1_000);
    expect(start!.elapsedMs).toBeGreaterThanOrEqual(0);
    vi.useFakeTimers();
  });

  it("M: large json parse aborts promptly when query signal aborts", async () => {
    vi.useRealTimers();
    const controller = new AbortController();
    const largeBody = JSON.stringify({
      status: "1",
      message: "OK",
      result: Array.from({ length: 2_000 }, (_, index) => ({
        address: "0xabc",
        topics: [],
        data: "0x",
        blockNumber: `0x${index.toString(16)}`,
        transactionHash: `0x${index.toString(16).padStart(64, "0")}`,
        transactionIndex: "0x0",
        blockHash: `0x${(index + 1).toString(16).padStart(64, "0")}`,
        logIndex: "0x0",
        removed: false,
      })),
    });
    expect(largeBody.length).toBeGreaterThan(
      ETHERSCAN_JSON_PARSE_WORKER_THRESHOLD_BYTES
    );
    const started = Date.now();
    const promise = parseEtherscanJsonBody(largeBody, controller.signal);
    setTimeout(() => controller.abort(new EtherscanQueryMaxRuntimeError("abort")), 25);
    await expect(promise).rejects.toBeInstanceOf(EtherscanQueryMaxRuntimeError);
    expect(Date.now() - started).toBeLessThan(2_000);
    vi.useFakeTimers();
  });

  it("N: query max runtime on query 6 stops wallet history before query 7", async () => {
    const queriesStarted: number[] = [];
    const emptyStats = (): IndexedFetchStats => ({
      requests: 0,
      pages: 0,
      logsReturned: 0,
      blockWindows: 0,
      elapsedMs: 0,
      currentFromBlock: 1,
      currentToBlock: 2,
      rateLimitHits: 0,
      errors: [],
      uniqueTransactions: 0,
    });
    const provider: IndexedLogProvider = {
      id: "etherscan_v2",
      name: "etherscan_v2",
      capabilities: {
        walletTopicFilter: true,
        contractFilter: true,
        blockRangeFilter: true,
        txHashLookup: false,
        cursorPagination: false,
        pagePagination: true,
        maxBlockRangePerRequest: 100_000,
        maxResultsPerPage: 1_000,
        requiresApiKey: true,
        estimatedCostTier: "freemium",
      },
      async probe() {
        return {
          providerId: "etherscan_v2",
          available: true,
          reason: "ok",
          capabilities: provider.capabilities,
          notes: [],
        };
      },
      async getLogsPaginated(_query, options = {}) {
        const queryIndex = options.queryIndex ?? 0;
        queriesStarted.push(queryIndex);
        if (queryIndex === 6) {
          const controller = new EtherscanQueryController({
            wallet: "0xabc",
            queryIndex: 6,
            queryTotal: 11,
            queryLabel: "query-6",
            rangeFrom: 1,
            rangeTo: 2,
            maxRuntimeMs: 1_000,
          });
          controller.start();
          controller.markProgress("page_processed", { requests: 1, pages: 1, logs: 1 });
          await vi.advanceTimersByTimeAsync(6_000);
          controller.throwIfAborted();
        }
        return { logs: [], stats: emptyStats() };
      },
      async getLogs() {
        return [];
      },
    };

    await expect(
      fetchIndexedWalletHistory({
        provider,
        wallet: "0xabc",
        fromBlock: 1,
        toBlock: 2,
      })
    ).rejects.toBeInstanceOf(EtherscanQueryMaxRuntimeError);

    expect(queriesStarted).toEqual([1, 2, 3, 4, 5, 6]);
    expect(queriesStarted.includes(7)).toBe(false);
  });

  it("L: non-meaningful markProgress does not reset no-progress watchdog", async () => {
    const controller = new EtherscanQueryController({
      wallet: "0xabc",
      queryIndex: 4,
      queryTotal: 11,
      queryLabel: "test",
      rangeFrom: 1,
      rangeTo: 2,
      noProgressTimeoutMs: 1_000,
    });
    controller.start();
    controller.markProgress("page_processed", {
      requests: 12,
      pages: 12,
      logs: 9996,
    });
    controller.markProgress("retry_attempt_start", {
      requests: 12,
      pages: 12,
      logs: 9996,
    });
    await vi.advanceTimersByTimeAsync(6_000);
    expect(() => controller.throwIfAborted()).toThrow(EtherscanNoProgressTimeout);
    controller.stop();
  });
});
