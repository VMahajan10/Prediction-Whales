import { cacheKey, readIndexedCache, writeIndexedCache } from "@/lib/walletLedger/indexed/cache";
import type {
  IndexedFetchStats,
  IndexedLogProvider,
} from "@/lib/walletLedger/indexed/types";
import {
  CONDITIONAL_TOKENS_ADDRESS,
  POLYMARKET_EXCHANGE_INITIAL_BLOCK,
  TOPIC_CONDITION_RESOLUTION,
} from "@/lib/walletLedger/onchain/contracts";
import { decodeLog } from "@/lib/walletLedger/onchain/decode";
import { dedupeLogs } from "@/lib/walletLedger/onchain/rpc";
import type { ParsedConditionResolution, RpcLog } from "@/lib/walletLedger/onchain/types";

export interface FetchIndexedResolutionsInput {
  provider: IndexedLogProvider;
  conditionIds: string[];
  fromBlock?: number;
  toBlock: number;
  useCache?: boolean;
}

export interface FetchIndexedResolutionsResult {
  logs: RpcLog[];
  resolutions: ParsedConditionResolution[];
  stats: IndexedFetchStats;
}

export async function fetchIndexedConditionResolutions(
  input: FetchIndexedResolutionsInput
): Promise<FetchIndexedResolutionsResult> {
  if (input.provider.id !== "etherscan_v2") {
    return {
      logs: [],
      resolutions: [],
      stats: {
        requests: 0,
        pages: 0,
        logsReturned: 0,
        blockWindows: 0,
        elapsedMs: 0,
        currentFromBlock: 0,
        currentToBlock: input.toBlock,
        rateLimitHits: 0,
        errors: ["resolution_index_requires_etherscan_provider"],
        uniqueTransactions: 0,
      },
    };
  }
  const fromBlock = input.fromBlock ?? POLYMARKET_EXCHANGE_INITIAL_BLOCK;
  const uniqueIds = [
    ...new Set(input.conditionIds.map((id) => id.toLowerCase()).filter(Boolean)),
  ];

  const key = cacheKey([
    input.provider.id,
    "resolution",
    uniqueIds.sort().join(",").slice(0, 64),
    String(fromBlock),
    String(input.toBlock),
  ]);

  if (input.useCache !== false) {
    const cached = readIndexedCache<FetchIndexedResolutionsResult>(key);
    if (cached) return cached;
  }

  const started = Date.now();
  const stats: IndexedFetchStats = {
    requests: 0,
    pages: 0,
    logsReturned: 0,
    blockWindows: 0,
    elapsedMs: 0,
    currentFromBlock: fromBlock,
    currentToBlock: input.toBlock,
    rateLimitHits: 0,
    errors: [],
    uniqueTransactions: 0,
  };

  const allLogs: RpcLog[] = [];

  for (const conditionId of uniqueIds) {
    const { logs, stats: batchStats } = await input.provider.getLogsPaginated({
      fromBlock,
      toBlock: input.toBlock,
      address: CONDITIONAL_TOKENS_ADDRESS,
      topics: [TOPIC_CONDITION_RESOLUTION, conditionId],
    });
    allLogs.push(...logs);
    stats.requests = batchStats.requests;
    stats.pages += batchStats.pages;
    stats.blockWindows += batchStats.blockWindows;
    stats.rateLimitHits = batchStats.rateLimitHits;
    stats.errors = [...new Set([...stats.errors, ...batchStats.errors])];
  }

  const deduped = dedupeLogs(allLogs);
  stats.logsReturned = deduped.length;
  stats.uniqueTransactions = new Set(deduped.map((l) => l.transactionHash)).size;
  stats.elapsedMs = Date.now() - started;

  const resolutions: ParsedConditionResolution[] = [];
  for (const log of deduped) {
    const parsed = decodeLog(log);
    if (parsed.type === "condition_resolution") {
      resolutions.push(parsed.event);
    }
  }

  const output: FetchIndexedResolutionsResult = {
    logs: deduped,
    resolutions,
    stats,
  };

  if (input.useCache !== false) writeIndexedCache(key, output);
  return output;
}
