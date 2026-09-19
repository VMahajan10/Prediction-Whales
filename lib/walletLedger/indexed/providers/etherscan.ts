import { fetchTextWithTimeout } from "@/lib/fetchWithTimeout";
import {
  CHECKPOINT_SCHEMA_VERSION,
  QUERY_PLAN_VERSION,
  buildQueryCheckpointKey,
  computeCheckpointResumePlan,
  logCheckpointResume,
  readEtherscanCheckpointForIdentity,
  readEtherscanCheckpointManifest,
  type QueryCheckpointIdentity,
} from "@/lib/walletLedger/indexed/checkpoint";
import {
  CheckpointLogSession,
} from "@/lib/walletLedger/indexed/checkpointLogStore";
import {
  ETHERSCAN_REQUEST_TIMEOUT_MS,
  fetchEtherscanWithRetry,
} from "@/lib/walletLedger/indexed/etherscanRetry";
import {
  EtherscanNoProgressTimeout,
  isEtherscanNoProgressTimeout,
  isEtherscanProviderCircuitOpenError,
  isEtherscanQueryMaxRuntimeError,
} from "@/lib/walletLedger/indexed/etherscanErrors";
import { parseEtherscanJsonBody } from "@/lib/walletLedger/indexed/etherscanJsonParse";
import { isProviderCircuitOpen } from "@/lib/walletLedger/indexed/shadow/providerCircuitBreaker";
import {
  combineAbortSignals,
  EtherscanQueryController,
  yieldToEventLoop,
  type EtherscanQueryControllerOptions,
} from "@/lib/walletLedger/indexed/etherscanQueryController";
import {
  logEtherscanPageLifecycle,
  nextEtherscanRequestId,
} from "@/lib/walletLedger/indexed/etherscanPageLifecycle";
import {
  EtherscanPhaseMetricsCollector,
  getActiveEtherscanPhaseMetricsCollector,
  logEtherscanQueryPhaseSummary,
  setActiveEtherscanPhaseMetricsCollector,
  stashEtherscanPhaseMetricsSummary,
} from "@/lib/walletLedger/indexed/etherscanPhaseMetrics";
import {
  isEtherscanBlockRangeError,
  isEtherscanResultLimitError,
  rangeKey,
  shouldSplitRange,
  splitBlockRange,
  type AdaptiveRangeStats,
} from "@/lib/walletLedger/indexed/etherscanAdaptive";
import {
  EtherscanRateLimiter,
  getSharedEtherscanRateLimiter,
  resolveEtherscanRequestsPerSecond,
} from "@/lib/walletLedger/indexed/etherscanRateLimiter";
import {
  auditLog,
  type EtherscanProgressReporter,
} from "@/lib/walletLedger/indexed/auditProgress";
import { appendAll } from "@/lib/walletLedger/indexed/arrayUtils";
import {
  highestCompletedBlock,
  normalizeRanges,
} from "@/lib/walletLedger/indexed/checkpointIntervals";
import { ETHERSCAN_MAX_BLOCK_RANGE } from "@/lib/walletLedger/indexed/queryPlan";
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
const DEFAULT_BLOCK_WINDOW = ETHERSCAN_MAX_BLOCK_RANGE;
const DEFAULT_PAGE_SIZE = 1_000;

type FetchPageOutcome =
  | { kind: "logs"; logs: RpcLog[] }
  | { kind: "empty" }
  | { kind: "error"; message: string; rateLimited: boolean; splitRange: boolean };

function resolveApiKey(): string | null {
  return (
    process.env.ETHERSCAN_API_KEY?.trim() ||
    process.env.POLYGONSCAN_API_KEY?.trim() ||
    null
  );
}

export function describeEtherscanResultType(result: unknown): string {
  if (result === null) return "null";
  if (result === undefined) return "undefined";
  if (Array.isArray(result)) return `array(length=${result.length})`;
  return typeof result;
}

/** HTTP 200 + status=0 empty getLogs is a successful query with no matching logs. */
export function isEtherscanEmptySuccess(json: {
  status?: unknown;
  message?: unknown;
  result?: unknown;
}): boolean {
  const message = String(json.message ?? "");
  if (/no records found/i.test(message)) return true;
  return (
    String(json.status) === "0" &&
    Array.isArray(json.result) &&
    json.result.length === 0 &&
    !/notok/i.test(message)
  );
}

/** Never use String(result) when result may be []. */
export function getEtherscanErrorMessage(json: {
  status?: unknown;
  message?: unknown;
  result?: unknown;
}): string {
  const result = json.result;
  const message = typeof json.message === "string" ? json.message.trim() : "";
  if (typeof result === "string" && result.trim()) return result.trim();
  if (message) return message;
  if (Array.isArray(result)) {
    return result.length === 0
      ? "empty_result_array"
      : `result_array(length=${result.length})`;
  }
  if (result != null) return `result_type=${typeof result}`;
  return "unknown_etherscan_error";
}

/** @deprecated Use isEtherscanEmptySuccess */
export const isEtherscanEmptyLogSuccess = isEtherscanEmptySuccess;

/** @deprecated Use getEtherscanErrorMessage */
export const formatEtherscanProbeError = getEtherscanErrorMessage;

export type EtherscanLogsOutcome =
  | { kind: "logs"; logs: RpcLog[] }
  | { kind: "empty" }
  | { kind: "error"; message: string; rateLimited: boolean };

export function classifyEtherscanLogsResponse(json: {
  status: string;
  message: string;
  result: unknown;
}): EtherscanLogsOutcome {
  if (json.status === "1") {
    if (!Array.isArray(json.result)) return { kind: "empty" };
    return {
      kind: "logs",
      logs: json.result.map((row) =>
        normalizeRpcLog(row as Record<string, string>)
      ),
    };
  }
  if (isEtherscanEmptySuccess(json)) return { kind: "empty" };
  const message = getEtherscanErrorMessage(json);
  return {
    kind: "error",
    message,
    rateLimited: /rate|limit/i.test(message),
  };
}

function toHexBlock(block: number): string {
  return `0x${block.toString(16)}`;
}

function normalizeRpcLog(row: Record<string, string>): RpcLog {
  const rawTimestamp = row.timeStamp ?? row.timestamp;
  const blockTimestamp =
    rawTimestamp != null && rawTimestamp !== ""
      ? Number.parseInt(String(rawTimestamp), 10)
      : undefined;
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
    blockTimestamp:
      blockTimestamp != null && Number.isFinite(blockTimestamp)
        ? blockTimestamp
        : undefined,
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
  retryAttempts = 0;
  retryErrors: string[] = [];
  emptyRequests = 0;
  nonEmptyRequests = 0;
  rangesQueried = 0;
  rangesSplit = 0;
  pagesFetched = 0;
  readonly rateLimiter: EtherscanRateLimiter;
  private activeProgress: EtherscanProgressReporter | null = null;
  private activeQueryLabel = "";
  private activeRangeFrom = 0;
  private activeRangeTo = 0;
  private activePage = 0;
  private activeQueryController: EtherscanQueryController | null = null;
  private activeWallet = "";
  private activeQueryIndex = 0;
  private activeQueryTotal = 0;
  private activeAbortSignal: AbortSignal | null = null;

  constructor(apiKey = resolveApiKey(), rateLimiter?: EtherscanRateLimiter) {
    this.apiKey = apiKey;
    this.rateLimiter = rateLimiter ?? getSharedEtherscanRateLimiter();
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

      const { response: res, text } = await fetchTextWithTimeout(url.toString(), {
        timeoutMs: 15_000,
      });
      const json = JSON.parse(text) as {
        status: string;
        message: string;
        result: unknown;
      };
      this.requests += 1;

      if (!res.ok) {
        return {
          providerId: this.id,
          available: false,
          probeLatencyMs: Date.now() - started,
          error: `http_${res.status}`,
          capabilities: this.capabilities,
          notes: ["probe_http_error"],
        };
      }

      if (json.status !== "1") {
        if (isEtherscanEmptySuccess(json)) {
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
              "probe_empty_logs_ok",
            ],
          };
        }
        const msg = getEtherscanErrorMessage(json);
        if (/rate|limit/i.test(msg)) this.rateLimitHits += 1;
        return {
          providerId: this.id,
          available: false,
          probeLatencyMs: Date.now() - started,
          error: msg,
          capabilities: this.capabilities,
          notes: [
            "probe_getLogs_failed",
            `etherscan_status=${json.status}`,
            `etherscan_message=${json.message}`,
            `result_type=${describeEtherscanResultType(json.result)}`,
          ],
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
    const outcome = await this.fetchLogsPage(query);
    if (outcome.kind === "logs") return outcome.logs;
    return [];
  }

  private async fetchLogsPage(
    query: IndexedLogQuery,
    context?: {
      requestId?: string;
      attempt?: number;
    }
  ): Promise<FetchPageOutcome> {
    if (!this.apiKey) return { kind: "empty" };
    const requestId = context?.requestId ?? nextEtherscanRequestId();
    const pageStarted = Date.now();
    const fromBlock = query.fromBlock;
    const toBlock = query.toBlock;
    const page = query.page ?? 1;
    const attempt = context?.attempt ?? 1;
    const lifecycle = (
      phase: Parameters<typeof logEtherscanPageLifecycle>[0]["phase"]
    ) => {
      logEtherscanPageLifecycle({
        phase,
        wallet: this.activeWallet,
        queryIndex: this.activeQueryIndex,
        queryTotal: this.activeQueryTotal,
        rangeFrom: fromBlock,
        rangeTo: toBlock,
        page,
        attempt,
        requestId,
        elapsedMs: Date.now() - pageStarted,
      });
    };

    lifecycle("page_scheduled");
    this.activeQueryController?.throwIfAborted();

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
        } else {
          url.searchParams.set(`topic${i}`, topic);
        }
      }
    }

    lifecycle("limiter_wait_start");
    const releaseLimiter = await this.rateLimiter.acquire(
      this.activeAbortSignal ?? undefined
    );
    lifecycle("limiter_acquired");
    try {
      const { response: res, bodyText, stats: retryStats } =
        await fetchEtherscanWithRetry(url.toString(), {
          timeoutMs: ETHERSCAN_REQUEST_TIMEOUT_MS,
          signal: this.activeAbortSignal ?? undefined,
          onLifecycle: (phase, lifecycleAttempt, elapsedMs) => {
            logEtherscanPageLifecycle({
              phase,
              wallet: this.activeWallet,
              queryIndex: this.activeQueryIndex,
              queryTotal: this.activeQueryTotal,
              rangeFrom: fromBlock,
              rangeTo: toBlock,
              page,
              attempt: lifecycleAttempt,
              requestId,
              elapsedMs,
            });
          },
          onTimeout: ({ attempt: timeoutAttempt, elapsedMs, hangPhase }) => {
            this.activeProgress?.logTimeout({
              queryLabel: this.activeQueryLabel,
              fromBlock,
              toBlock,
              page,
              attempt: timeoutAttempt,
              elapsedMs,
              hangPhase,
            });
          },
        });
      this.activeProgress?.noteResponse();
      this.retryAttempts += retryStats.retries;
      this.retryErrors.push(...retryStats.retryErrors);

      await yieldToEventLoop(this.activeAbortSignal ?? undefined);
      this.activeQueryController?.throwIfAborted();
      const collector = getActiveEtherscanPhaseMetricsCollector();
      const parseStarted = Date.now();
      const json = await parseEtherscanJsonBody(
        bodyText,
        this.activeAbortSignal ?? undefined,
        () => this.activeQueryController?.throwIfAborted()
      );
      if (collector) {
        collector.recordPhase("json_parse", Date.now() - parseStarted, {
          inputBytes: bodyText.length,
          page,
          rangeFrom: fromBlock,
          rangeTo: toBlock,
        });
      }
      lifecycle("json_parsed");

      this.requests += 1;
      this.pagesFetched += 1;
      this.activeProgress?.updateCounts({
        requests: this.requests,
        pages: this.pagesFetched,
        splits: this.rangesSplit,
        rateLimitHits: this.rateLimitHits,
      });
      this.activeQueryController?.markProgress("page_processed", {
        requests: this.requests,
        pages: this.pagesFetched,
      });

      if (!res.ok) {
        const msg = `http_${res.status}`;
        this.errors.push(msg);
        return {
          kind: "error",
          message: msg,
          rateLimited: res.status === 429,
          splitRange: res.status === 429,
        };
      }

      const outcome = collector
        ? collector.measureSync(
            "log_normalization",
            () => classifyEtherscanLogsResponse(json),
            { logCount: Array.isArray(json.result) ? json.result.length : 0, page }
          )
        : classifyEtherscanLogsResponse(json);
      lifecycle("request_complete");
      if (outcome.kind === "empty") {
        this.emptyRequests += 1;
        return { kind: "empty" };
      }
      if (outcome.kind === "error") {
        this.errors.push(outcome.message);
        if (outcome.rateLimited) this.rateLimitHits += 1;
        return {
          kind: "error",
          message: outcome.message,
          rateLimited: outcome.rateLimited,
          splitRange:
            outcome.rateLimited ||
            isEtherscanBlockRangeError(outcome.message) ||
            isEtherscanResultLimitError(outcome.message),
        };
      }
      this.nonEmptyRequests += 1;
      return { kind: "logs", logs: outcome.logs };
    } finally {
      releaseLimiter();
      lifecycle("limiter_released");
    }
  }

  private async fetchRangeAdaptive(
    query: Omit<IndexedLogQuery, "page" | "offset">,
    fromBlock: number,
    toBlock: number,
    pageSize: number,
    adaptive: AdaptiveRangeStats,
    completedRanges: Set<string>,
    checkpointKey?: string,
    checkpointIdentity?: QueryCheckpointIdentity,
    session?: CheckpointLogSession
  ): Promise<RpcLog[]> {
    const key = rangeKey(fromBlock, toBlock);
    if (completedRanges.has(key)) return [];

    adaptive.rangesQueried += 1;
    this.rangesQueried += 1;
    this.activeRangeFrom = fromBlock;
    this.activeRangeTo = toBlock;
    this.activeProgress?.rangeStart(fromBlock, toBlock);

    const rangeLogs: RpcLog[] = [];
    let page = 1;
    let lastPageSize = 0;
    let splitReason: string | undefined;

    while (true) {
      this.activePage = page;
      this.activeQueryController?.throwIfAborted();
      const outcome = await this.fetchLogsPage({
        ...query,
        fromBlock,
        toBlock,
        page,
        offset: pageSize,
      });

      if (outcome.kind === "error") {
        this.activeQueryController?.throwIfAborted();
        if (outcome.splitRange) splitReason = outcome.message;
        break;
      }
      if (outcome.kind === "empty") {
        this.activeProgress?.pageFetched(page, 0);
        if (page === 1) {
          completedRanges.add(key);
          await this.persistRangeCheckpoint(session, completedRanges, []);
          this.activeProgress?.rangeEnd(fromBlock, toBlock, 0, false);
          return [];
        }
        break;
      }

      const collector = getActiveEtherscanPhaseMetricsCollector();
      if (collector) {
        collector.measureSync(
          "range_accumulation",
          () => {
            appendAll(rangeLogs, outcome.logs);
          },
          { logCount: outcome.logs.length, page }
        );
      } else {
        appendAll(rangeLogs, outcome.logs);
      }
      this.activeProgress?.pageFetched(page, outcome.logs.length);
      this.activeQueryController?.markProgress("page_processed", {
        requests: this.requests,
        pages: this.pagesFetched,
        logs: adaptive.logsReturned + rangeLogs.length,
      });
      lastPageSize = outcome.logs.length;
      if (outcome.logs.length < pageSize) break;
      page += 1;

      if (
        shouldSplitRange({
          fromBlock,
          toBlock,
          pagesFetched: page,
          lastPageSize,
          pageSize,
        })
      ) {
        splitReason = "pagination_or_result_ceiling";
        break;
      }
    }

    const needsSplit = shouldSplitRange({
      fromBlock,
      toBlock,
      errorMessage: splitReason,
      pagesFetched: page,
      lastPageSize,
      pageSize,
    });

    if (!needsSplit) {
      completedRanges.add(key);
      adaptive.logsReturned += rangeLogs.length;
      await this.persistRangeCheckpoint(session, completedRanges, rangeLogs);
      this.activeProgress?.rangeEnd(fromBlock, toBlock, rangeLogs.length, false);
      return rangeLogs;
    }

    if (fromBlock >= toBlock) {
      completedRanges.add(key);
      adaptive.logsReturned += rangeLogs.length;
      await this.persistRangeCheckpoint(session, completedRanges, rangeLogs);
      this.activeProgress?.rangeEnd(fromBlock, toBlock, rangeLogs.length, false);
      return rangeLogs;
    }

    adaptive.rangesSplit += 1;
    this.rangesSplit += 1;
    this.activeProgress?.rangeEnd(fromBlock, toBlock, rangeLogs.length, true);
    if (rangeLogs.length > 0) {
      await this.persistRangeCheckpoint(session, completedRanges, rangeLogs);
    }
    const [left, right] = splitBlockRange(fromBlock, toBlock);
    const leftLogs = await this.fetchRangeAdaptive(
      query,
      left.from,
      left.to,
      pageSize,
      adaptive,
      completedRanges,
      checkpointKey,
      checkpointIdentity,
      session
    );
    const rightLogs = await this.fetchRangeAdaptive(
      query,
      right.from,
      right.to,
      pageSize,
      adaptive,
      completedRanges,
      checkpointKey,
      checkpointIdentity,
      session
    );
    const merged = dedupeAdaptiveLogs(
      (() => {
        const combined: RpcLog[] = [];
        appendAll(combined, rangeLogs);
        appendAll(combined, leftLogs);
        appendAll(combined, rightLogs);
        return combined;
      })()
    );
    adaptive.logsReturned += merged.length;
    return merged;
  }

  private async persistRangeCheckpoint(
    session: CheckpointLogSession | undefined,
    completedRanges: Set<string>,
    newLogs: RpcLog[]
  ): Promise<void> {
    if (!session) return;
    if (newLogs.length > 0) {
      await session.appendLogsAsync(newLogs);
    }
    const ranges = normalizeRanges(
      [...completedRanges].map((k) => {
        const [from, to] = k.split(":").map(Number);
        return { from, to };
      })
    );
    session.updateProgress({
      completedRanges: ranges,
      requests: this.requests,
      pages: this.pagesFetched,
      errors: [...this.errors],
    });
    session.flush();
    await yieldToEventLoop(this.activeAbortSignal ?? undefined);
    this.activeQueryController?.markProgress("checkpoint_committed", {
      requests: this.requests,
      pages: this.pagesFetched,
      completedRanges: ranges.length,
    });
  }

  private flushCommittedCheckpoint(
    logSession: CheckpointLogSession,
    completedRanges: Set<string>
  ): void {
    const completedRangeList = normalizeRanges(
      [...completedRanges].map((k) => {
        const [from, to] = k.split(":").map(Number);
        return { from, to };
      })
    );
    logSession.updateProgress({
      completedRanges: completedRangeList,
      requests: this.requests,
      pages: this.pagesFetched,
      errors: [...this.errors],
    });
    logSession.flush();
  }

  async getLogsPaginated(
    query: Omit<IndexedLogQuery, "page" | "offset">,
    options: {
      offset?: number;
      interPageDelayMs?: number;
      onProgress?: (stats: IndexedFetchStats) => void;
      checkpointKey?: string;
      checkpointIdentity?: QueryCheckpointIdentity;
      resumeCheckpoint?: boolean;
      progress?: EtherscanProgressReporter;
      queryIndex?: number;
      queryTotal?: number;
      queryLabel?: string;
      wallet?: string;
      abortSignal?: AbortSignal;
    } = {}
  ): Promise<{ logs: RpcLog[]; stats: IndexedFetchStats }> {
    const pageSize = options.offset ?? DEFAULT_PAGE_SIZE;
    const started = Date.now();
    const requestsAtStart = this.requests;
    const pagesAtStart = this.pagesFetched;
    const rateLimitHitsAtStart = this.rateLimitHits;
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

    const checkpointIdentity =
      options.checkpointIdentity ??
      ({
        providerId: "etherscan_v2",
        chainId: POLYGON_CHAIN_ID,
        wallet: "0x0",
        contract: query.address.toLowerCase(),
        stableFromBlock: query.fromBlock,
        topics: query.topics ?? [],
      } satisfies QueryCheckpointIdentity);

    const checkpointKey =
      options.checkpointKey ?? buildQueryCheckpointKey(checkpointIdentity);

    const existing =
      options.resumeCheckpoint === false
        ? null
        : readEtherscanCheckpointForIdentity(checkpointIdentity, {
            includeLogs: false,
          });

    const resumePlan = computeCheckpointResumePlan(
      query.fromBlock,
      query.toBlock,
      existing?.completedRanges ?? []
    );

    if (options.progress && options.queryIndex != null) {
      logCheckpointResume({
        queryIndex: options.queryIndex,
        queryTotal: options.queryTotal ?? options.queryIndex,
        plan: resumePlan,
        hit: existing != null,
      });
    }

    if (existing && options.progress) {
      options.progress.logCheckpointLoaded(
        checkpointKey,
        existing.logCount ?? existing.logs.length,
        existing.completedRanges.length
      );
    }

    const completedRanges = new Set<string>(
      (existing?.completedRanges ?? []).map((r) => rangeKey(r.from, r.to))
    );
    if (existing?.completedWindowEnds) {
      for (const end of existing.completedWindowEnds) {
        completedRanges.add(rangeKey(query.fromBlock, end));
      }
    }

    const adaptive: AdaptiveRangeStats = {
      rangesQueried: 0,
      rangesSplit: 0,
      pagesFetched: 0,
      logsReturned: existing?.logCount ?? existing?.logs?.length ?? 0,
    };

    let logSession: CheckpointLogSession;
    const existingManifest = readEtherscanCheckpointManifest(checkpointKey);
    if (existingManifest) {
      logSession = CheckpointLogSession.open(existingManifest);
    } else {
      logSession = CheckpointLogSession.create({
        key: checkpointKey,
        checkpointVersion: CHECKPOINT_SCHEMA_VERSION,
        queryPlanVersion: QUERY_PLAN_VERSION,
        identity: checkpointIdentity,
      });
    }

    const queryLabel =
      options.queryLabel ??
      `${query.address.slice(0, 10)}…/${query.fromBlock}-${query.toBlock}`;
    this.activeProgress = options.progress ?? null;
    this.activeQueryLabel = queryLabel;
    this.activeWallet = options.wallet ?? checkpointIdentity.wallet;
    this.activeQueryIndex = options.queryIndex ?? 0;
    this.activeQueryTotal = options.queryTotal ?? options.queryIndex ?? 0;
    this.activeAbortSignal = options.abortSignal ?? null;
    options.progress?.bindRateLimiter(this.rateLimiter);

    const queryController = new EtherscanQueryController({
      wallet: this.activeWallet,
      queryIndex: this.activeQueryIndex,
      queryTotal: this.activeQueryTotal,
      queryLabel,
      rangeFrom: query.fromBlock,
      rangeTo: query.toBlock,
    } satisfies EtherscanQueryControllerOptions);
    this.activeQueryController = queryController;
    this.activeAbortSignal = combineAbortSignals([
      options.abortSignal,
      queryController.signal,
    ]);
    queryController.start();
    options.progress?.bindQueryProgressClock(() =>
      queryController.getLastProgressAgoMs()
    );

    if (options.progress && options.queryIndex != null) {
      options.progress.beginQuery(
        options.queryIndex,
        queryLabel,
        query.fromBlock,
        query.toBlock
      );
    }

    const existingMetrics = getActiveEtherscanPhaseMetricsCollector();
    const ownedCollector = existingMetrics == null;
    const phaseMetrics =
      existingMetrics ??
      (() => {
        const created = new EtherscanPhaseMetricsCollector();
        created.beginWallet(this.activeWallet);
        setActiveEtherscanPhaseMetricsCollector(created);
        return created;
      })();
    phaseMetrics.beginQuery(this.activeQueryIndex);

    const progressHeartbeat = setInterval(() => {
      queryController.setRuntimeState({
        limiterActive: this.rateLimiter.activeSlots,
        limiterWaiting: this.rateLimiter.waitingCount,
        providerCircuitOpen: isProviderCircuitOpen(),
      });
      options.progress?.bindQueryProgressClock(() =>
        queryController.getLastProgressAgoMs()
      );
    }, 5_000);

    try {
      const gaps =
        resumePlan.uncoveredRanges.length > 0
          ? resumePlan.uncoveredRanges
          : existing
            ? []
            : [{ from: query.fromBlock, to: query.toBlock }];

      for (const gap of gaps) {
        queryController.throwIfAborted();
        await this.fetchRangeAdaptive(
          query,
          gap.from,
          gap.to,
          pageSize,
          adaptive,
          completedRanges,
          checkpointKey,
          checkpointIdentity,
          logSession
        );
      }

      queryController.throwIfAborted();
      await yieldToEventLoop(this.activeAbortSignal ?? undefined);
      queryController.throwIfAborted();
      const rawLogs = await logSession.readAllLogsAsync(
        undefined,
        (loaded) => {
          this.activeQueryController?.markProgress("read_all_logs", {
            logs: loaded,
          });
        },
        this.activeAbortSignal ?? undefined
      );
      const allLogs = await dedupeAdaptiveLogsAsync(rawLogs);
      const completedRangeList = normalizeRanges(
        [...completedRanges].map((k) => {
          const [from, to] = k.split(":").map(Number);
          return { from, to };
        })
      );

      stats.requests = this.requests - requestsAtStart;
      stats.pages = this.pagesFetched - pagesAtStart;
      stats.blockWindows = adaptive.rangesQueried;
      stats.logsReturned = allLogs.length;
      stats.rateLimitHits = this.rateLimitHits - rateLimitHitsAtStart;
      stats.errors = [...this.errors];
      stats.elapsedMs = Date.now() - started;
      stats.uniqueTransactions = new Set(allLogs.map((l) => l.transactionHash)).size;
      options.onProgress?.(stats);

      logSession.updateProgress({
        completedRanges: completedRangeList,
        requests: this.requests,
        pages: stats.pages,
        errors: [...this.errors],
      });
      logSession.flush();
      options.progress?.logCheckpointSaved(
        checkpointKey,
        allLogs.length,
        completedRanges.size
      );
      if (options.progress && options.queryIndex != null) {
        options.progress.endQuery(options.queryIndex, queryLabel, allLogs.length);
      }

      return { logs: allLogs, stats };
    } catch (error) {
      queryController.stop();
      this.flushCommittedCheckpoint(logSession, completedRanges);
      if (isEtherscanQueryMaxRuntimeError(error)) {
        auditLog(
          `[etherscan-query-defer] wallet=${this.activeWallet} query=${this.activeQueryIndex}/${this.activeQueryTotal} ` +
            `reason=${error.reason} checkpoint=${checkpointKey}`
        );
        throw error;
      }
      if (
        isEtherscanNoProgressTimeout(error) ||
        isEtherscanProviderCircuitOpenError(error)
      ) {
        throw error;
      }
      throw error;
    } finally {
      clearInterval(progressHeartbeat);
      if (ownedCollector) {
        const summary = phaseMetrics.summarize();
        logEtherscanQueryPhaseSummary(summary);
        stashEtherscanPhaseMetricsSummary(summary);
        setActiveEtherscanPhaseMetricsCollector(null);
      }
      queryController.stop();
      this.activeQueryController = null;
      this.activeAbortSignal = null;
      this.activeProgress = null;
    }
  }

  async getLogsByTxHash(txHash: string): Promise<RpcLog[]> {
    if (!this.apiKey) return [];
    const url = new URL(ETHERSCAN_V2_BASE);
    url.searchParams.set("chainid", POLYGON_CHAIN_ID);
    url.searchParams.set("module", "proxy");
    url.searchParams.set("action", "eth_getTransactionReceipt");
    url.searchParams.set("txhash", txHash);
    url.searchParams.set("apikey", this.apiKey);

    const { response: res, text } = await fetchTextWithTimeout(url.toString(), {
      timeoutMs: 15_000,
    });
    const json = JSON.parse(text) as {
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

function dedupeAdaptiveLogs(logs: RpcLog[]): RpcLog[] {
  const map = new Map<string, RpcLog>();
  for (const log of logs) {
    map.set(`${log.transactionHash}:${log.logIndex}`, log);
  }
  return [...map.values()];
}

async function dedupeAdaptiveLogsAsync(logs: RpcLog[]): Promise<RpcLog[]> {
  const collector = getActiveEtherscanPhaseMetricsCollector();
  if (!collector) return dedupeAdaptiveLogs(logs);
  return collector.measureAsync(
    "query_dedupe",
    async () => {
      const map = new Map<string, RpcLog>();
      let processed = 0;
      for (const log of logs) {
        map.set(`${log.transactionHash}:${log.logIndex}`, log);
        processed += 1;
        if (processed % 10_000 === 0) {
          await yieldToEventLoop();
        }
      }
      return [...map.values()];
    },
    { logCount: logs.length }
  );
}

export { toHexBlock, resolveEtherscanRequestsPerSecond };
