import { fetchWithTimeout } from "@/lib/fetchWithTimeout";
import type {
  IndexedFetchStats,
  IndexedLogProvider,
  IndexedLogQuery,
  IndexedProviderCapabilities,
  IndexedProviderProbeResult,
} from "@/lib/walletLedger/indexed/types";
import type { RpcLog } from "@/lib/walletLedger/onchain/types";

const BLOCKSCOUT_BASE = "https://polygon.blockscout.com/api/v2";

const CAPABILITIES: IndexedProviderCapabilities = {
  walletTopicFilter: false,
  contractFilter: true,
  blockRangeFilter: false,
  txHashLookup: true,
  cursorPagination: true,
  pagePagination: false,
  maxBlockRangePerRequest: null,
  maxResultsPerPage: 50,
  requiresApiKey: false,
  estimatedCostTier: "free",
};

interface BlockscoutLogItem {
  address?: { hash?: string };
  data?: string;
  topics?: string[];
  block_number?: number;
  transaction_hash?: string;
  index?: number;
}

export class BlockscoutLogProvider implements IndexedLogProvider {
  readonly id = "blockscout" as const;
  readonly name = "Polygon Blockscout v2";
  readonly capabilities = CAPABILITIES;

  requests = 0;
  rateLimitHits = 0;
  errors: string[] = [];

  async probe(): Promise<IndexedProviderProbeResult> {
    const started = Date.now();
    try {
      const url = `${BLOCKSCOUT_BASE}/transactions/0x59c3aad53bf226ee382efb4b33bbaa4b43563d4298450011e06c9837e891232a/logs?items_count=1`;
      const res = await fetchWithTimeout(url, { timeoutMs: 15_000 });
      this.requests += 1;
      if (!res.ok) {
        return {
          providerId: this.id,
          available: false,
          probeLatencyMs: Date.now() - started,
          error: `http_${res.status}`,
          capabilities: this.capabilities,
          notes: ["tx_receipt_logs_only"],
        };
      }
      return {
        providerId: this.id,
        available: true,
        probeLatencyMs: Date.now() - started,
        error: null,
        capabilities: this.capabilities,
        notes: [
          "address_logs_endpoint_returns_emitter_logs_not_topic_participant",
          "unsuitable_for_polymarket_maker_taker_orderfilled_queries",
          "tx_hash_log_lookup_works",
        ],
      };
    } catch (error) {
      return {
        providerId: this.id,
        available: false,
        probeLatencyMs: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
        capabilities: this.capabilities,
        notes: ["probe_failed"],
      };
    }
  }

  async getLogs(_query: IndexedLogQuery): Promise<RpcLog[]> {
    this.errors.push("blockscout_does_not_support_contract_topic_getLogs");
    return [];
  }

  async getLogsPaginated(): Promise<{ logs: RpcLog[]; stats: IndexedFetchStats }> {
    return {
      logs: [],
      stats: {
        requests: this.requests,
        pages: 0,
        logsReturned: 0,
        blockWindows: 0,
        elapsedMs: 0,
        currentFromBlock: 0,
        currentToBlock: 0,
        rateLimitHits: this.rateLimitHits,
        errors: [...this.errors],
        uniqueTransactions: 0,
      },
    };
  }

  async getLogsByTxHash(txHash: string): Promise<RpcLog[]> {
    const all: RpcLog[] = [];
    let cursor: Record<string, string | number> | null = null;

    while (true) {
      const params = new URLSearchParams({ items_count: "50" });
      if (cursor) {
        for (const [key, value] of Object.entries(cursor)) {
          params.set(key, String(value));
        }
      }
      const url = `${BLOCKSCOUT_BASE}/transactions/${txHash}/logs?${params}`;
      const res = await fetchWithTimeout(url, { timeoutMs: 15_000 });
      this.requests += 1;
      if (!res.ok) {
        this.errors.push(`http_${res.status}`);
        break;
      }
      const json = (await res.json()) as {
        items?: BlockscoutLogItem[];
        next_page_params?: Record<string, string | number> | null;
      };
      for (const item of json.items ?? []) {
        if (!item.address?.hash || !item.transaction_hash) continue;
        all.push({
          address: item.address.hash.toLowerCase(),
          topics: item.topics ?? [],
          data: item.data ?? "0x",
          blockNumber: `0x${(item.block_number ?? 0).toString(16)}`,
          transactionHash: item.transaction_hash.toLowerCase(),
          logIndex: `0x${(item.index ?? 0).toString(16)}`,
        });
      }
      cursor = json.next_page_params ?? null;
      if (!cursor) break;
    }

    return all;
  }
}
