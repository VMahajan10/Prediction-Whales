import { fetchWithTimeout } from "@/lib/fetchWithTimeout";
import type {
  IndexedFetchStats,
  IndexedLogProvider,
  IndexedLogQuery,
  IndexedProviderCapabilities,
  IndexedProviderProbeResult,
} from "@/lib/walletLedger/indexed/types";
import type { RpcLog } from "@/lib/walletLedger/onchain/types";

const POLYGON_CHAIN_ID = "137";
const ETHERSCAN_V2_BASE = "https://api.etherscan.io/v2/api";
const DEFAULT_BLOCK_WINDOW = 4_999;
const DEFAULT_PAGE_SIZE = 1_000;
const DEFAULT_INTER_PAGE_DELAY_MS = 220;

function resolveApiKey(): string | null {
  return (
    process.env.ETHERSCAN_API_KEY?.trim() ||
    process.env.POLYGONSCAN_API_KEY?.trim() ||
    null
  );
}

function toHexBlock(block: number): string {
  return `0x${block.toString(16)}`;
}

function normalizeRpcLog(row: Record<string, string>): RpcLog {
  return {
    address: row.address.toLowerCase(),
    topics: Array.isArray(row.topics) ? row.topics : [],
    data: row.data,
    blockNumber: row.blockNumber.startsWith("0x")
      ? row.blockNumber
      : `0x${Number(row.blockNumber).toString(16)}`,
    transactionHash: row.transactionHash.toLowerCase(),
    logIndex: row.logIndex.startsWith("0x")
      ? row.logIndex
      : `0x${Number(row.logIndex).toString(16)}`,
    blockHash: row.blockHash,
    transactionIndex: row.transactionIndex,
    removed: row.removed === "true",
  };
}

const CAPABILITIES: IndexedProviderCapabilities = {
  walletTopicFilter: true,
  contractFilter: true,
  blockRangeFilter: true,
  txHashLookup: true,
  cursorPagination: false,
  pagePagination: true,
  maxBlockRangePerRequest: 5_000,
  maxResultsPerPage: 1_000,
  requiresApiKey: true,
  estimatedCostTier: "freemium",
};

export class EtherscanV2LogProvider implements IndexedLogProvider {
  readonly id = "etherscan_v2" as const;
  readonly name = "Etherscan API v2 (Polygon chainid=137)";
  readonly capabilities = CAPABILITIES;

  private readonly apiKey: string | null;
  requests = 0;
  rateLimitHits = 0;
  errors: string[] = [];

  constructor(apiKey = resolveApiKey()) {
    this.apiKey = apiKey;
  }

  async probe(): Promise<IndexedProviderProbeResult> {
    const started = Date.now();
    if (!this.apiKey) {
      return {
        providerId: this.id,
        available: false,
        probeLatencyMs: Date.now() - started,
        error: "missing_api_key",
        capabilities: this.capabilities,
        notes: [
          "set_ETHERSCAN_API_KEY_or_POLYGONSCAN_API_KEY",
          "unified_v2_endpoint_supports_polygon_via_chainid_137",
        ],
      };
    }

    try {
      const url = new URL(ETHERSCAN_V2_BASE);
      url.searchParams.set("chainid", POLYGON_CHAIN_ID);
      url.searchParams.set("module", "logs");
      url.searchParams.set("action", "getLogs");
      url.searchParams.set("fromBlock", "91800000");
      url.searchParams.set("toBlock", "91801000");
      url.searchParams.set(
        "address",
        "0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e"
      );
      url.searchParams.set(
        "topic0",
        "0xd0a08e8c493f9c94f29311604c9de1b4e8c8d4c06bd0c789af57f2d65bfec0f6"
      );
      url.searchParams.set("page", "1");
      url.searchParams.set("offset", "1");
      url.searchParams.set("apikey", this.apiKey);

      const res = await fetchWithTimeout(url.toString(), { timeoutMs: 15_000 });
      const json = (await res.json()) as {
        status: string;
        message: string;
        result: unknown;
      };
      this.requests += 1;

      if (json.status !== "1") {
        const msg = String(json.result ?? json.message);
        if (/rate|limit/i.test(msg)) this.rateLimitHits += 1;
        return {
          providerId: this.id,
          available: false,
          probeLatencyMs: Date.now() - started,
          error: msg,
          capabilities: this.capabilities,
          notes: ["probe_getLogs_failed"],
        };
      }

      return {
        providerId: this.id,
        available: true,
        probeLatencyMs: Date.now() - started,
        error: null,
        capabilities: this.capabilities,
        notes: [
          "indexed_logs_with_topic_and_block_filters",
          "5000_block_window_per_request",
          "1000_results_per_page",
        ],
      };
    } catch (error) {
      return {
        providerId: this.id,
        available: false,
        probeLatencyMs: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
        capabilities: this.capabilities,
        notes: ["probe_network_error"],
      };
    }
  }

  async getLogs(query: IndexedLogQuery): Promise<RpcLog[]> {
    if (!this.apiKey) return [];
    const url = new URL(ETHERSCAN_V2_BASE);
    url.searchParams.set("chainid", POLYGON_CHAIN_ID);
    url.searchParams.set("module", "logs");
    url.searchParams.set("action", "getLogs");
    url.searchParams.set("fromBlock", String(query.fromBlock));
    url.searchParams.set("toBlock", String(query.toBlock));
    url.searchParams.set("address", query.address);
    url.searchParams.set("page", String(query.page ?? 1));
    url.searchParams.set("offset", String(query.offset ?? DEFAULT_PAGE_SIZE));
    url.searchParams.set("apikey", this.apiKey);

    if (query.topics) {
      for (let i = 0; i < query.topics.length; i += 1) {
        const topic = query.topics[i];
        if (topic == null) continue;
        if (Array.isArray(topic)) {
          url.searchParams.set(`topic${i}`, topic[0]);
          for (let j = 1; j < topic.length; j += 1) {
            url.searchParams.append(`topic${i}`, topic[j]);
          }
        } else {
          url.searchParams.set(`topic${i}`, topic);
        }
      }
    }

    const res = await fetchWithTimeout(url.toString(), { timeoutMs: 30_000 });
    const json = (await res.json()) as {
      status: string;
      message: string;
      result: unknown;
    };
    this.requests += 1;

    if (json.status !== "1") {
      const msg = String(json.result ?? json.message);
      this.errors.push(msg);
      if (/rate|limit/i.test(msg)) this.rateLimitHits += 1;
      return [];
    }

    if (!Array.isArray(json.result)) return [];
    return json.result.map((row) =>
      normalizeRpcLog(row as Record<string, string>)
    );
  }

  async getLogsPaginated(
    query: Omit<IndexedLogQuery, "page" | "offset">,
    options: {
      offset?: number;
      interPageDelayMs?: number;
      onProgress?: (stats: IndexedFetchStats) => void;
    } = {}
  ): Promise<{ logs: RpcLog[]; stats: IndexedFetchStats }> {
    const pageSize = options.offset ?? DEFAULT_PAGE_SIZE;
    const delay = options.interPageDelayMs ?? DEFAULT_INTER_PAGE_DELAY_MS;
    const started = Date.now();
    const stats: IndexedFetchStats = {
      requests: 0,
      pages: 0,
      logsReturned: 0,
      blockWindows: 0,
      elapsedMs: 0,
      currentFromBlock: query.fromBlock,
      currentToBlock: query.toBlock,
      rateLimitHits: 0,
      errors: [],
      uniqueTransactions: 0,
    };

    const allLogs: RpcLog[] = [];

    for (
      let from = query.fromBlock;
      from <= query.toBlock;
      from += DEFAULT_BLOCK_WINDOW + 1
    ) {
      const to = Math.min(from + DEFAULT_BLOCK_WINDOW, query.toBlock);
      stats.blockWindows += 1;
      stats.currentFromBlock = from;
      stats.currentToBlock = to;

      let page = 1;
      while (true) {
        const batch = await this.getLogs({
          ...query,
          fromBlock: from,
          toBlock: to,
          page,
          offset: pageSize,
        });
        stats.requests = this.requests;
        stats.pages += 1;
        stats.logsReturned += batch.length;
        stats.rateLimitHits = this.rateLimitHits;
        stats.errors = [...this.errors];
        stats.elapsedMs = Date.now() - started;
        options.onProgress?.(stats);

        allLogs.push(...batch);
        if (batch.length < pageSize) break;
        page += 1;
        if (delay > 0) {
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }

      if (delay > 0 && to < query.toBlock) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    const uniqueTx = new Set(allLogs.map((l) => l.transactionHash));
    stats.uniqueTransactions = uniqueTx.size;
    stats.elapsedMs = Date.now() - started;
    return { logs: allLogs, stats };
  }

  async getLogsByTxHash(txHash: string): Promise<RpcLog[]> {
    if (!this.apiKey) return [];
    const url = new URL(ETHERSCAN_V2_BASE);
    url.searchParams.set("chainid", POLYGON_CHAIN_ID);
    url.searchParams.set("module", "proxy");
    url.searchParams.set("action", "eth_getTransactionReceipt");
    url.searchParams.set("txhash", txHash);
    url.searchParams.set("apikey", this.apiKey);

    const res = await fetchWithTimeout(url.toString(), { timeoutMs: 15_000 });
    const json = (await res.json()) as {
      result?: { logs?: RpcLog[] };
      error?: { message: string };
    };
    this.requests += 1;
    if (json.error) {
      this.errors.push(json.error.message);
      return [];
    }
    return json.result?.logs ?? [];
  }
}

export function blockWindows(
  fromBlock: number,
  toBlock: number,
  windowSize = DEFAULT_BLOCK_WINDOW
): Array<{ from: number; to: number }> {
  const windows: Array<{ from: number; to: number }> = [];
  for (let from = fromBlock; from <= toBlock; from += windowSize + 1) {
    windows.push({ from, to: Math.min(from + windowSize, toBlock) });
  }
  return windows;
}

export { toHexBlock };
