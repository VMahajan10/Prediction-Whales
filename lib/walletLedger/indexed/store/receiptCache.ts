import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EtherscanV2LogProvider } from "@/lib/walletLedger/indexed/providers/etherscan";
import { parseBlockNumber, PolygonRpcClient } from "@/lib/walletLedger/onchain/rpc";
import { POLYGON_RPC_URLS } from "@/lib/walletLedger/onchain/rpcUrls";
import type { RpcLog, RpcTransactionReceipt } from "@/lib/walletLedger/onchain/types";

const RECEIPT_CACHE_DIR = join(process.cwd(), ".cache", "polygon-tx-receipts");
const CACHE_VERSION = 2;

export type ReceiptCacheStatus =
  | "valid_receipt"
  | "receipt_not_found"
  | "provider_error"
  | "timeout"
  | "malformed_response"
  | "empty_response";

export interface ReceiptCacheEntry {
  v: typeof CACHE_VERSION;
  txHash: string;
  status: ReceiptCacheStatus;
  provider?: string;
  attemptCount: number;
  lastAttemptAt: string;
  lastError?: string;
  receipt?: RpcTransactionReceipt | null;
}

export interface ReceiptCacheAuditSummary {
  totalFiles: number;
  validReceipt: number;
  receiptNotFound: number;
  providerError: number;
  timeout: number;
  malformedResponse: number;
  emptyResponse: number;
  legacyRawReceipt: number;
  legacyInvalidJson: number;
  retryableFailures: number;
}

export interface ReceiptFetchResult {
  receipt: RpcTransactionReceipt | null;
  cacheHit: boolean;
  providerFailure: boolean;
  cacheStatus?: ReceiptCacheStatus;
  recoveredVia?: "cache" | "rpc" | "rpc_alternate" | "etherscan";
}

const RETRYABLE_STATUSES = new Set<ReceiptCacheStatus>([
  "provider_error",
  "timeout",
  "malformed_response",
  "empty_response",
]);

function receiptCachePath(txHash: string): string {
  const hash = createHash("sha256")
    .update(txHash.toLowerCase())
    .digest("hex")
    .slice(0, 32);
  return join(RECEIPT_CACHE_DIR, `${hash}.json`);
}

function isLegacyRawReceipt(value: unknown): value is RpcTransactionReceipt {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.transactionHash === "string" &&
    typeof record.blockNumber === "string" &&
    Array.isArray(record.logs)
  );
}

function classifyLegacyReceipt(
  txHash: string,
  receipt: RpcTransactionReceipt
): ReceiptCacheEntry {
  if (receipt.logs.length > 0) {
    return {
      v: CACHE_VERSION,
      txHash: txHash.toLowerCase(),
      status: "valid_receipt",
      provider: "legacy_migration",
      attemptCount: 1,
      lastAttemptAt: new Date().toISOString(),
      receipt,
    };
  }
  return {
    v: CACHE_VERSION,
    txHash: txHash.toLowerCase(),
    status: "empty_response",
    provider: "legacy_migration",
    attemptCount: 1,
    lastAttemptAt: new Date().toISOString(),
    lastError: "legacy cache stored receipt with zero logs",
    receipt,
  };
}

function parseCacheEntry(raw: unknown, txHash: string): ReceiptCacheEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (record.v === CACHE_VERSION && typeof record.status === "string") {
    return raw as ReceiptCacheEntry;
  }
  if (isLegacyRawReceipt(raw)) {
    return classifyLegacyReceipt(txHash, raw);
  }
  return null;
}

export function readReceiptCacheEntry(txHash: string): ReceiptCacheEntry | null {
  const path = receiptCachePath(txHash);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    const entry = parseCacheEntry(raw, txHash);
    if (!entry) {
      return {
        v: CACHE_VERSION,
        txHash: txHash.toLowerCase(),
        status: "malformed_response",
        attemptCount: 1,
        lastAttemptAt: new Date().toISOString(),
        lastError: "cache file JSON is not a receipt or v2 entry",
      };
    }
    if (isLegacyRawReceipt(raw)) {
      writeReceiptCacheEntry(entry);
    }
    return entry;
  } catch (error) {
    return {
      v: CACHE_VERSION,
      txHash: txHash.toLowerCase(),
      status: "malformed_response",
      attemptCount: 1,
      lastAttemptAt: new Date().toISOString(),
      lastError: error instanceof Error ? error.message : String(error),
    };
  }
}

export function writeReceiptCacheEntry(entry: ReceiptCacheEntry): void {
  mkdirSync(RECEIPT_CACHE_DIR, { recursive: true });
  writeFileSync(receiptCachePath(entry.txHash), JSON.stringify(entry, null, 2));
}

export function invalidateReceiptCache(txHashes: string[]): void {
  for (const txHash of txHashes) {
    const path = receiptCachePath(txHash);
    if (existsSync(path)) {
      try {
        unlinkSync(path);
      } catch {
        // ignore
      }
    }
  }
}

export function isRetryableReceiptCacheStatus(
  status: ReceiptCacheStatus | undefined
): boolean {
  return status != null && RETRYABLE_STATUSES.has(status);
}

export function isSuccessfulReceiptCacheEntry(
  entry: ReceiptCacheEntry | null
): entry is ReceiptCacheEntry & { status: "valid_receipt" } {
  return entry?.status === "valid_receipt";
}

function isTimeoutError(message: string): boolean {
  return /timeout|timed out|aborted|ETIMEDOUT|ECONNRESET/i.test(message);
}

async function fetchReceiptViaRpc(
  txHash: string,
  rpcUrls: string[],
  providerLabel: string
): Promise<{
  receipt: RpcTransactionReceipt | null;
  providerFailure: boolean;
  status: ReceiptCacheStatus;
  error?: string;
}> {
  const client = new PolygonRpcClient({ rpcUrls, maxRetries: 1 });
  try {
    const receipt = await client.getTransactionReceipt(txHash);
    if (receipt == null) {
      return {
        receipt: null,
        providerFailure: false,
        status: "receipt_not_found",
      };
    }
    return {
      receipt,
      providerFailure: false,
      status: "valid_receipt",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      receipt: null,
      providerFailure: true,
      status: isTimeoutError(message) ? "timeout" : "provider_error",
      error: `${providerLabel}: ${message}`,
    };
  }
}

async function fetchReceiptViaEtherscan(
  txHash: string,
  etherscan: EtherscanV2LogProvider
): Promise<{
  receipt: RpcTransactionReceipt | null;
  providerFailure: boolean;
  status: ReceiptCacheStatus;
  error?: string;
}> {
  try {
    const logs = await etherscan.getLogsByTxHash(txHash);
    if (logs.length === 0) {
      return {
        receipt: null,
        providerFailure: false,
        status: "receipt_not_found",
      };
    }
    return {
      receipt: {
        blockNumber: logs[0]!.blockNumber,
        transactionHash: txHash.toLowerCase(),
        logs,
      },
      providerFailure: false,
      status: "valid_receipt",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      receipt: null,
      providerFailure: true,
      status: isTimeoutError(message) ? "timeout" : "provider_error",
      error: `etherscan: ${message}`,
    };
  }
}

export async function fetchTransactionReceiptCached(input: {
  txHash: string;
  rpc?: PolygonRpcClient;
  etherscan?: EtherscanV2LogProvider;
  forceRefetch?: boolean;
}): Promise<ReceiptFetchResult> {
  const txHash = input.txHash.toLowerCase();
  if (!input.forceRefetch) {
    const cached = readReceiptCacheEntry(txHash);
    if (cached && cached.status === "valid_receipt" && cached.receipt) {
      return {
        receipt: cached.receipt,
        cacheHit: true,
        providerFailure: false,
        cacheStatus: cached.status,
        recoveredVia: "cache",
      };
    }
    if (cached && cached.status === "receipt_not_found") {
      return {
        receipt: null,
        cacheHit: true,
        providerFailure: false,
        cacheStatus: cached.status,
        recoveredVia: "cache",
      };
    }
    if (cached && !isRetryableReceiptCacheStatus(cached.status)) {
      return {
        receipt: null,
        cacheHit: true,
        providerFailure: cached.status !== "receipt_not_found",
        cacheStatus: cached.status,
        recoveredVia: "cache",
      };
    }
  }

  const prior = readReceiptCacheEntry(txHash);
  const attemptCount = (prior?.attemptCount ?? 0) + 1;
  const primaryRpc = process.env.POLYGON_RPC_URL?.trim();
  const sharedUrls = [...POLYGON_RPC_URLS];
  const primaryUrls = primaryRpc ? [primaryRpc] : sharedUrls.slice(0, 1);
  const alternateUrls = primaryRpc
    ? [...sharedUrls.filter((url) => url !== primaryRpc)]
    : sharedUrls.slice(1);

  let lastError: string | undefined;
  let lastStatus: ReceiptCacheStatus = "provider_error";

  const primary = await fetchReceiptViaRpc(
    txHash,
    primaryUrls.length > 0 ? primaryUrls : sharedUrls,
    "polygon_rpc_primary"
  );
  if (primary.status === "valid_receipt" && primary.receipt) {
    const entry: ReceiptCacheEntry = {
      v: CACHE_VERSION,
      txHash,
      status: "valid_receipt",
      provider: "polygon_rpc_primary",
      attemptCount,
      lastAttemptAt: new Date().toISOString(),
      receipt: primary.receipt,
    };
    writeReceiptCacheEntry(entry);
    return {
      receipt: primary.receipt,
      cacheHit: false,
      providerFailure: false,
      cacheStatus: entry.status,
      recoveredVia: "rpc",
    };
  }
  if (primary.status === "receipt_not_found") {
    const entry: ReceiptCacheEntry = {
      v: CACHE_VERSION,
      txHash,
      status: "receipt_not_found",
      provider: "polygon_rpc_primary",
      attemptCount,
      lastAttemptAt: new Date().toISOString(),
      receipt: null,
    };
    writeReceiptCacheEntry(entry);
    return {
      receipt: null,
      cacheHit: false,
      providerFailure: false,
      cacheStatus: entry.status,
    };
  }
  lastError = primary.error;
  lastStatus = primary.status;

  if (alternateUrls.length > 0) {
    const alternate = await fetchReceiptViaRpc(
      txHash,
      alternateUrls,
      "polygon_rpc_alternate"
    );
    if (alternate.status === "valid_receipt" && alternate.receipt) {
      const entry: ReceiptCacheEntry = {
        v: CACHE_VERSION,
        txHash,
        status: "valid_receipt",
        provider: "polygon_rpc_alternate",
        attemptCount,
        lastAttemptAt: new Date().toISOString(),
        receipt: alternate.receipt,
      };
      writeReceiptCacheEntry(entry);
      return {
        receipt: alternate.receipt,
        cacheHit: false,
        providerFailure: false,
        cacheStatus: entry.status,
        recoveredVia: "rpc_alternate",
      };
    }
    if (alternate.status === "receipt_not_found") {
      const entry: ReceiptCacheEntry = {
        v: CACHE_VERSION,
        txHash,
        status: "receipt_not_found",
        provider: "polygon_rpc_alternate",
        attemptCount,
        lastAttemptAt: new Date().toISOString(),
        receipt: null,
      };
      writeReceiptCacheEntry(entry);
      return {
        receipt: null,
        cacheHit: false,
        providerFailure: false,
        cacheStatus: entry.status,
        recoveredVia: "rpc_alternate",
      };
    }
    lastError = alternate.error ?? lastError;
    lastStatus = alternate.status;
  }

  const etherscan = input.etherscan ?? new EtherscanV2LogProvider();
  const fallback = await fetchReceiptViaEtherscan(txHash, etherscan);
  if (fallback.status === "valid_receipt" && fallback.receipt) {
    const entry: ReceiptCacheEntry = {
      v: CACHE_VERSION,
      txHash,
      status: "valid_receipt",
      provider: "etherscan_v2",
      attemptCount,
      lastAttemptAt: new Date().toISOString(),
      receipt: fallback.receipt,
    };
    writeReceiptCacheEntry(entry);
    return {
      receipt: fallback.receipt,
      cacheHit: false,
      providerFailure: false,
      cacheStatus: entry.status,
      recoveredVia: "etherscan",
    };
  }
  if (fallback.status === "receipt_not_found") {
    const entry: ReceiptCacheEntry = {
      v: CACHE_VERSION,
      txHash,
      status: "receipt_not_found",
      provider: "etherscan_v2",
      attemptCount,
      lastAttemptAt: new Date().toISOString(),
      receipt: null,
    };
    writeReceiptCacheEntry(entry);
    return {
      receipt: null,
      cacheHit: false,
      providerFailure: false,
      cacheStatus: entry.status,
      recoveredVia: "etherscan",
    };
  }

  const failureStatus = fallback.status ?? lastStatus;
  const failureEntry: ReceiptCacheEntry = {
    v: CACHE_VERSION,
    txHash,
    status: failureStatus,
    provider: "etherscan_v2",
    attemptCount,
    lastAttemptAt: new Date().toISOString(),
    lastError: fallback.error ?? lastError,
  };
  writeReceiptCacheEntry(failureEntry);
  return {
    receipt: null,
    cacheHit: false,
    providerFailure: true,
    cacheStatus: failureStatus,
  };
}

export function auditReceiptCache(): ReceiptCacheAuditSummary {
  if (!existsSync(RECEIPT_CACHE_DIR)) {
    return {
      totalFiles: 0,
      validReceipt: 0,
      receiptNotFound: 0,
      providerError: 0,
      timeout: 0,
      malformedResponse: 0,
      emptyResponse: 0,
      legacyRawReceipt: 0,
      legacyInvalidJson: 0,
      retryableFailures: 0,
    };
  }

  const summary: ReceiptCacheAuditSummary = {
    totalFiles: 0,
    validReceipt: 0,
    receiptNotFound: 0,
    providerError: 0,
    timeout: 0,
    malformedResponse: 0,
    emptyResponse: 0,
    legacyRawReceipt: 0,
    legacyInvalidJson: 0,
    retryableFailures: 0,
  };

  for (const file of readdirSync(RECEIPT_CACHE_DIR).filter((name) =>
    name.endsWith(".json")
  )) {
    summary.totalFiles += 1;
    const txHash = file.replace(/\.json$/, "");
    try {
      const raw = JSON.parse(
        readFileSync(join(RECEIPT_CACHE_DIR, file), "utf8")
      ) as unknown;
      if (isLegacyRawReceipt(raw)) {
        summary.legacyRawReceipt += 1;
        if (raw.logs.length > 0) summary.validReceipt += 1;
        else summary.emptyResponse += 1;
        summary.retryableFailures += raw.logs.length > 0 ? 0 : 1;
        continue;
      }
      const entry = parseCacheEntry(raw, txHash);
      if (!entry) {
        summary.legacyInvalidJson += 1;
        summary.malformedResponse += 1;
        summary.retryableFailures += 1;
        continue;
      }
      switch (entry.status) {
        case "valid_receipt":
          summary.validReceipt += 1;
          break;
        case "receipt_not_found":
          summary.receiptNotFound += 1;
          break;
        case "provider_error":
          summary.providerError += 1;
          summary.retryableFailures += 1;
          break;
        case "timeout":
          summary.timeout += 1;
          summary.retryableFailures += 1;
          break;
        case "malformed_response":
          summary.malformedResponse += 1;
          summary.retryableFailures += 1;
          break;
        case "empty_response":
          summary.emptyResponse += 1;
          summary.retryableFailures += 1;
          break;
      }
    } catch {
      summary.legacyInvalidJson += 1;
      summary.malformedResponse += 1;
      summary.retryableFailures += 1;
    }
  }

  return summary;
}

export function receiptHasUsableLogs(receipt: RpcTransactionReceipt | null | undefined): boolean {
  return Boolean(receipt && Array.isArray(receipt.logs) && receipt.logs.length > 0);
}

export function filterReceiptLogsForBlock(
  receipt: RpcTransactionReceipt,
  blockNumber: number
): RpcLog[] {
  return receipt.logs.filter(
    (log) => parseBlockNumber(log.blockNumber) === blockNumber
  );
}
