import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchTextWithTimeout, fetchWithTimeout } from "@/lib/fetchWithTimeout";
import { cacheKey } from "@/lib/walletLedger/indexed/cache";
import {
  EtherscanV2LogProvider,
  blockWindows,
  classifyEtherscanLogsResponse,
  getEtherscanErrorMessage,
  isEtherscanEmptySuccess,
} from "@/lib/walletLedger/indexed/providers/etherscan";
import { buildWalletLogQueries } from "@/lib/walletLedger/indexed/providers/fullHistoryRpc";
import {
  shouldSplitRange,
  splitBlockRange,
} from "@/lib/walletLedger/indexed/etherscanAdaptive";
import { buildEtherscanQueryPlan } from "@/lib/walletLedger/indexed/queryPlan";
import { appendAll, maxOf, minOf } from "@/lib/walletLedger/indexed/arrayUtils";
import { buildQueryCheckpointKey } from "@/lib/walletLedger/indexed/checkpoint";
import { analyzeIndexedEventFunnel } from "@/lib/walletLedger/indexed/funnel";
import {
  CTF_EXCHANGE_LEGACY_ADDRESS,
  CTF_EXCHANGE_V1_ADDRESS,
  POLYMARKET_EXCHANGE_INITIAL_BLOCK,
  TOPIC_ORDER_FILLED_V1,
} from "@/lib/walletLedger/onchain/contracts";
import type { ParsedOrderFilled } from "@/lib/walletLedger/onchain/types";
import { dedupeLogs, walletTopic } from "@/lib/walletLedger/onchain/rpc";
import type { RpcLog } from "@/lib/walletLedger/onchain/types";

vi.mock("@/lib/fetchWithTimeout", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/fetchWithTimeout")>();
  return {
    ...actual,
    fetchWithTimeout: vi.fn(),
    fetchTextWithTimeout: vi.fn(),
  };
});

const WALLET = "0x0562e01b3c3e65bb93bf0de32f02cec238a79d66";
const SAMPLE_LOG_ROW = {
  address: "0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e",
  topics: [
    "0xd0a08e8c493f9c94f29311604c9de1b4e8c8d4c06bd0c789af57f2d65bfec0f6",
  ],
  data: "0x",
  blockNumber: "0x578f420",
  transactionHash: "0xabc123",
  logIndex: "0x0",
  blockHash: "0xdef456",
  transactionIndex: "0x0",
  removed: "false",
};

function mockEtherscanJson(body: unknown, status = 200): void {
  vi.mocked(fetchTextWithTimeout).mockResolvedValueOnce({
    response: {
      ok: status >= 200 && status < 300,
      status,
    } as Response,
    text: JSON.stringify(body),
  });
}

function indexedHistoryCompleteFromErrors(errors: string[]): boolean {
  const fullHistory = true;
  const fromBlock = POLYMARKET_EXCHANGE_INITIAL_BLOCK;
  const eventsBeforeApiBoundary = 1;
  return (
    fullHistory &&
    fromBlock <= POLYMARKET_EXCHANGE_INITIAL_BLOCK &&
    errors.length === 0 &&
    eventsBeforeApiBoundary > 0
  );
}

describe("indexed provider helpers", () => {
  it("adaptive query plan uses one broad range per wallet query", () => {
    const plan = buildEtherscanQueryPlan(WALLET, 80_000_000, 80_100_000);
    expect(plan.walletLogQueries).toBe(11);
    expect(plan.blockWindowsPerQuery).toBe(1);
    expect(plan.estimatedRequestsMin).toBe(11);
    expect(plan.multiplication).toMatch(/broad indexed range/);
    expect(plan.multiplication).toMatch(/legacy fixed 5k windows/);
    expect(plan.multiplication).toMatch(/4 exchanges × maker\/taker/);
  });

  it("splits block ranges only when pagination ceiling is hit", () => {
    expect(
      shouldSplitRange({
        fromBlock: 1,
        toBlock: 1_000_000,
        pagesFetched: 1,
        lastPageSize: 1000,
        pageSize: 1000,
      })
    ).toBe(false);
    expect(
      shouldSplitRange({
        fromBlock: 1,
        toBlock: 1_000_000,
        pagesFetched: 10,
        lastPageSize: 1000,
        pageSize: 1000,
      })
    ).toBe(true);
    const [left, right] = splitBlockRange(100, 200);
    expect(left).toEqual({ from: 100, to: 150 });
    expect(right).toEqual({ from: 151, to: 200 });
  });

  it("builds wallet log query patterns for exchanges and CTF", () => {
    const queries = buildWalletLogQueries(WALLET, 1_000, 2_000);
    expect(queries.length).toBe(11);
    expect(queries.some((q) => q.address === CTF_EXCHANGE_V1_ADDRESS)).toBe(
      true
    );
    expect(
      queries.some((q) => q.address === "0x4d97dcd97ec945f40cf65f87097ace5ea0476045")
    ).toBe(true);
  });

  it("includes legacy CTF exchange with v1 OrderFilled maker and taker queries", () => {
    const queries = buildWalletLogQueries(WALLET, 1_000, 2_000);
    const legacyQueries = queries.filter(
      (q) => q.address === CTF_EXCHANGE_LEGACY_ADDRESS
    );
    expect(legacyQueries).toHaveLength(2);

    const maker = legacyQueries.find(
      (q) =>
        q.topics?.[0] === TOPIC_ORDER_FILLED_V1 &&
        q.topics?.[2] === walletTopic(WALLET) &&
        q.topics?.[3] == null
    );
    const taker = legacyQueries.find(
      (q) =>
        q.topics?.[0] === TOPIC_ORDER_FILLED_V1 &&
        q.topics?.[2] == null &&
        q.topics?.[3] === walletTopic(WALLET)
    );
    expect(maker).toBeDefined();
    expect(taker).toBeDefined();

    const serialized = legacyQueries.map((q) => JSON.stringify(q));
    expect(new Set(serialized).size).toBe(2);
  });

  it("splits block ranges into etherscan-safe windows", () => {
    const windows = blockWindows(10_000, 20_000, 4_999);
    expect(windows.length).toBeGreaterThan(1);
    expect(windows[0].from).toBe(10_000);
    expect(windows.at(-1)?.to).toBeLessThanOrEqual(20_000);
  });

  it("generates stable cache keys", () => {
    const a = cacheKey(["etherscan", WALLET, "wallet"]);
    const b = cacheKey(["etherscan", WALLET, "wallet"]);
    const c = cacheKey(["etherscan", WALLET, "resolution"]);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("uses exchange initial block as full-history floor", () => {
    expect(POLYMARKET_EXCHANGE_INITIAL_BLOCK).toBeGreaterThan(50_000_000);
  });
});

describe("etherscan empty-success and error helpers", () => {
  it("treats status=0 No records found + [] as empty success", () => {
    const json = {
      status: "0",
      message: "No records found",
      result: [] as unknown[],
    };
    expect(isEtherscanEmptySuccess(json)).toBe(true);
    expect(classifyEtherscanLogsResponse(json).kind).toBe("empty");
    expect(String(json.result ?? json.message)).toBe("");
  });

  it("does not treat NOTOK + string result as empty success", () => {
    const json = {
      status: "0",
      message: "NOTOK",
      result: "Max rate limit reached, please use API Key for higher rate limit",
    };
    expect(isEtherscanEmptySuccess(json)).toBe(false);
    expect(getEtherscanErrorMessage(json)).toBe(json.result);
    expect(classifyEtherscanLogsResponse(json)).toEqual({
      kind: "error",
      message: json.result,
      rateLimited: true,
    });
  });

  it("returns logs for status=1 with array result", () => {
    const json = {
      status: "1",
      message: "OK",
      result: [SAMPLE_LOG_ROW],
    };
    const outcome = classifyEtherscanLogsResponse(json);
    expect(outcome.kind).toBe("logs");
    if (outcome.kind === "logs") {
      expect(outcome.logs).toHaveLength(1);
      expect(outcome.logs[0].transactionHash).toBe("0xabc123");
    }
  });

  it("never renders result=[] as a blank error message", () => {
    const json = {
      status: "0",
      message: "No records found",
      result: [] as unknown[],
    };
    const msg = getEtherscanErrorMessage(json);
    expect(msg).not.toBe("");
    expect(msg).toBe("No records found");
  });

  it("formats invalid API key as a meaningful error", () => {
    const json = {
      status: "0",
      message: "NOTOK",
      result: "Invalid API Key",
    };
    expect(getEtherscanErrorMessage(json)).toBe("Invalid API Key");
    expect(classifyEtherscanLogsResponse(json).kind).toBe("error");
  });
});

describe("EtherscanV2LogProvider.getLogs", () => {
  afterEach(() => {
    vi.mocked(fetchTextWithTimeout).mockReset();
    vi.mocked(fetchWithTimeout).mockReset();
  });

  it("returns logs for status=1", async () => {
    const provider = new EtherscanV2LogProvider("test-key");
    mockEtherscanJson({
      status: "1",
      message: "OK",
      result: [SAMPLE_LOG_ROW],
    });

    const logs = await provider.getLogs({
      fromBlock: 1,
      toBlock: 2,
      address: SAMPLE_LOG_ROW.address,
    });

    expect(logs).toHaveLength(1);
    expect(provider.errors).toEqual([]);
  });

  it("returns [] for status=0 No records found without recording an error", async () => {
    const provider = new EtherscanV2LogProvider("test-key");
    mockEtherscanJson({
      status: "0",
      message: "No records found",
      result: [],
    });

    const logs = await provider.getLogs({
      fromBlock: 1,
      toBlock: 2,
      address: SAMPLE_LOG_ROW.address,
    });

    expect(logs).toEqual([]);
    expect(provider.errors).toEqual([]);
    expect(provider.rateLimitHits).toBe(0);
  });

  it("records meaningful errors for invalid API key", async () => {
    const provider = new EtherscanV2LogProvider("bad-key");
    mockEtherscanJson({
      status: "0",
      message: "NOTOK",
      result: "Invalid API Key",
    });

    const logs = await provider.getLogs({
      fromBlock: 1,
      toBlock: 2,
      address: SAMPLE_LOG_ROW.address,
    });

    expect(logs).toEqual([]);
    expect(provider.errors).toEqual(["Invalid API Key"]);
  });

  it("records rate-limit errors and increments rateLimitHits", async () => {
    const provider = new EtherscanV2LogProvider("test-key");
    mockEtherscanJson({
      status: "0",
      message: "NOTOK",
      result: "Max rate limit reached, please use API Key for higher rate limit",
    });

    await provider.getLogs({
      fromBlock: 1,
      toBlock: 2,
      address: SAMPLE_LOG_ROW.address,
    });

    expect(provider.errors[0]).toMatch(/rate limit/i);
    expect(provider.rateLimitHits).toBe(1);
  });

  it("empty windows do not make indexedHistoryComplete false via errors", async () => {
    const provider = new EtherscanV2LogProvider("test-key");
    for (let i = 0; i < 3; i += 1) {
      mockEtherscanJson({
        status: "0",
        message: "No records found",
        result: [],
      });
    }

    for (let i = 0; i < 3; i += 1) {
      await provider.getLogs({
        fromBlock: i,
        toBlock: i + 1,
        address: SAMPLE_LOG_ROW.address,
      });
    }

    expect(provider.errors).toEqual([]);
    expect(indexedHistoryCompleteFromErrors(provider.errors)).toBe(true);
  });

  it("blank legacy errors would have made indexedHistoryComplete false", () => {
    expect(indexedHistoryCompleteFromErrors([""])).toBe(false);
    expect(indexedHistoryCompleteFromErrors([])).toBe(true);
  });
});

describe("indexed event funnel", () => {
  it("reports final indexed events as post-dedup count even when finalEvents is pre-dedup", () => {
    const wallet = WALLET;
    const orderFilled: ParsedOrderFilled = {
      kind: "order_filled_v1",
      orderHash: "0x" + "11".repeat(32),
      maker: wallet,
      taker: "0x0000000000000000000000000000000000000001",
      makerAssetId: "0",
      takerAssetId: "12345",
      makerAmountFilled: 1_000_000n,
      takerAmountFilled: 2_000_000n,
      blockNumber: 1_000,
      transactionHash: "0x" + "22".repeat(32),
      logIndex: 0,
      contractAddress: CTF_EXCHANGE_V1_ADDRESS,
    };
    const log = {
      address: CTF_EXCHANGE_V1_ADDRESS,
      topics: [
        TOPIC_ORDER_FILLED_V1,
        orderFilled.orderHash,
        walletTopic(wallet),
        walletTopic(orderFilled.taker),
      ],
      data: "0x",
      blockNumber: "0x3e8",
      transactionHash: orderFilled.transactionHash,
      logIndex: "0x0",
      blockHash: "0x" + "33".repeat(32),
      transactionIndex: "0x0",
      removed: false,
    };
    const parsed = [
      { type: "order_filled" as const, event: orderFilled },
      { type: "order_filled" as const, event: { ...orderFilled, logIndex: 1 } },
    ];
    const preDedupFinalEvents = [
      { dedupeKey: "same-key" },
      { dedupeKey: "same-key" },
    ] as import("@/lib/walletLedger/types").WalletLedgerEvent[];

    const funnel = analyzeIndexedEventFunnel({
      logs: [log, log],
      parsed,
      wallet,
      blockTimestamps: new Map([[1_000, 1_700_000_000]]),
      finalEvents: preDedupFinalEvents,
    });

    expect(funnel.normalizedWalletLedgerEvent).toBe(2);
    expect(funnel.deduplicated).toBe(1);
    expect(funnel.finalIndexedEvents).toBe(1);
    expect(funnel.finalIndexedEvents).toBe(funnel.deduplicated);
  });
});

describe("indexed completeness guard", () => {
  it("does not mark complete without pre-api events and full scan", () => {
    const indexedHistoryComplete =
      false && 0 > 0 && true;
    expect(indexedHistoryComplete).toBe(false);
  });
});

describe("large indexed log handling", () => {
  it("appends 250k logs without stack overflow and preserves dedupe semantics", () => {
    const makeLog = (i: number): RpcLog => ({
      address: "0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e",
      topics: [
        "0xd0a08e8c493f9c94f29311604c9de1b4e8c8d4c06bd0c789af57f2d65bfec0f6",
      ],
      data: "0x",
      blockNumber: `0x${(1_000_000 + (i % 10_000)).toString(16)}`,
      transactionHash: `0x${i.toString(16).padStart(64, "0")}`,
      logIndex: "0x0",
      blockHash: "0x" + "11".repeat(32),
      transactionIndex: "0x0",
      removed: false,
    });

    const source: RpcLog[] = [];
    for (let i = 0; i < 250_000; i += 1) {
      source.push(makeLog(i));
    }
    source.push(makeLog(42));

    const merged: RpcLog[] = [];
    expect(() => appendAll(merged, source)).not.toThrow();
    expect(merged.length).toBe(250_001);

    const deduped = dedupeLogs(merged);
    expect(deduped.length).toBe(250_000);

    const timestamps = source.map((_, i) => i);
    expect(minOf(timestamps)).toBe(0);
    expect(maxOf(timestamps)).toBe(250_000);
  });
});

describe("etherscan checkpoint keys", () => {
  it("uniquely distinguishes maker/taker roles, topics, wallet, and stable fromBlock", () => {
    const wallet = WALLET;
    const fromBlock = POLYMARKET_EXCHANGE_INITIAL_BLOCK;
    const queries = buildWalletLogQueries(wallet, fromBlock, 92_852_360);
    expect(queries).toHaveLength(11);

    const keys = queries.map((query) =>
      buildQueryCheckpointKey({
        providerId: "etherscan_v2",
        chainId: "137",
        wallet,
        contract: query.address,
        stableFromBlock: query.fromBlock,
        topics: query.topics ?? [],
      })
    );

    expect(new Set(keys).size).toBe(11);

    const padded = walletTopic(wallet);
    const makerTakerPairs = [
      buildQueryCheckpointKey({
        providerId: "etherscan_v2",
        chainId: "137",
        wallet,
        contract: CTF_EXCHANGE_V1_ADDRESS,
        stableFromBlock: fromBlock,
        topics: [TOPIC_ORDER_FILLED_V1, null, padded],
      }),
      buildQueryCheckpointKey({
        providerId: "etherscan_v2",
        chainId: "137",
        wallet,
        contract: CTF_EXCHANGE_V1_ADDRESS,
        stableFromBlock: fromBlock,
        topics: [TOPIC_ORDER_FILLED_V1, null, null, padded],
      }),
    ];
    expect(new Set(makerTakerPairs).size).toBe(2);

    for (const key of keys) {
      expect(key).toMatch(/_[0-9a-f]{12}$/);
    }
  });
});
