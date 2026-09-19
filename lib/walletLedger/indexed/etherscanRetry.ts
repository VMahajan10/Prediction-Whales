import {
  FetchTimeoutError,
  fetchTextWithTimeout,
} from "@/lib/fetchWithTimeout";
import { getEtherscanErrorMessage } from "@/lib/walletLedger/indexed/providers/etherscan";
import {
  EtherscanNoProgressTimeout,
  EtherscanProviderCircuitOpenError,
} from "@/lib/walletLedger/indexed/etherscanErrors";
import { ProviderCircuitOpenError } from "@/lib/walletLedger/indexed/shadow/providerCircuitBreaker";
import type { EtherscanPageLifecyclePhase } from "@/lib/walletLedger/indexed/etherscanPageLifecycle";
import {
  createEtherscanRequestTimings,
  logEtherscanTimeoutDiagnostics,
  type EtherscanRequestTimings,
} from "@/lib/walletLedger/indexed/etherscanInstrumentation";
import {
  assertProviderCircuitAllowsRequest,
  recordProviderFailure,
  recordProviderSuccess,
} from "@/lib/walletLedger/indexed/shadow/providerCircuitBreaker";

export interface EtherscanRetryStats {
  attempts: number;
  retries: number;
  retryErrors: string[];
  lastTimings?: EtherscanRequestTimings;
}

const NON_RETRYABLE =
  /invalid.?api.?key|missing.?api.?key|unsupported chain|missing or unsupported chainid|malformed|syntax error/i;

export const ETHERSCAN_REQUEST_TIMEOUT_MS = 20_000;

export function isNonRetryableEtherscanError(message: string): boolean {
  return NON_RETRYABLE.test(message);
}

export function isTransientHttpStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export function isTransientFetchError(error: unknown): boolean {
  if (error instanceof FetchTimeoutError) return true;
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  return (
    msg.includes("etimedout") ||
    msg.includes("econnreset") ||
    msg.includes("econnrefused") ||
    msg.includes("network") ||
    msg.includes("fetch failed") ||
    msg.includes("aborted")
  );
}

function jitteredBackoffMs(attempt: number, baseMs = 400): number {
  const exp = baseMs * 2 ** attempt;
  const jitter = Math.floor(Math.random() * 200);
  return exp + jitter;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(
      new EtherscanNoProgressTimeout("Retry sleep aborted", undefined, "retry_wait")
    );
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(
        new EtherscanNoProgressTimeout("Retry sleep aborted", undefined, "retry_wait")
      );
    };
    signal?.addEventListener("abort", onAbort);
  });
}

export interface EtherscanTimeoutContext {
  attempt: number;
  elapsedMs: number;
  timeoutMs: number;
  timings?: EtherscanRequestTimings;
  hangPhase?: string;
}

export type EtherscanLifecycleHook = (
  phase: EtherscanPageLifecyclePhase,
  attempt: number,
  elapsedMs: number
) => void;

export async function fetchEtherscanWithRetry(
  url: string,
  options: RequestInit & {
    timeoutMs?: number;
    maxAttempts?: number;
    onTimeout?: (context: EtherscanTimeoutContext) => void;
    onLifecycle?: EtherscanLifecycleHook;
    signal?: AbortSignal;
  } = {}
): Promise<{ response: Response; bodyText: string; stats: EtherscanRetryStats }> {
  const maxAttempts = options.maxAttempts ?? 3;
  const timeoutMs = options.timeoutMs ?? ETHERSCAN_REQUEST_TIMEOUT_MS;
  const stats: EtherscanRetryStats = {
    attempts: 0,
    retries: 0,
    retryErrors: [],
  };

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    stats.attempts += 1;
    if (options.signal?.aborted) {
      throw new EtherscanNoProgressTimeout(
        "Etherscan fetch aborted before attempt",
        undefined,
        "fetch_start"
      );
    }
    const attemptStarted = Date.now();
    options.onLifecycle?.("retry_attempt_start", attempt + 1, 0);
    try {
      assertProviderCircuitAllowsRequest();
    } catch (error) {
      if (error instanceof ProviderCircuitOpenError) {
        throw new EtherscanProviderCircuitOpenError(error.message);
      }
      throw error;
    }
    const timings = createEtherscanRequestTimings(timeoutMs, url);
    try {
      options.onLifecycle?.("fetch_start", attempt + 1, Date.now() - attemptStarted);
      const { response, text } = await fetchTextWithTimeout(url, {
        ...options,
        timeoutMs,
        signal: options.signal,
      });
      timings.headersReceivedAt = Date.now();
      options.onLifecycle?.(
        "headers_received",
        attempt + 1,
        Date.now() - attemptStarted
      );
      timings.bodyReadStartedAt = attemptStarted;
      timings.bodyReadCompletedAt = Date.now();
      timings.requestEndedAt = timings.bodyReadCompletedAt;
      options.onLifecycle?.(
        "body_complete",
        attempt + 1,
        Date.now() - attemptStarted
      );
      stats.lastTimings = timings;

      if (isTransientHttpStatus(response.status)) {
        let body: { status?: string; message?: string; result?: unknown } = {};
        try {
          body = JSON.parse(text) as typeof body;
        } catch {
          body = {};
        }
        const msg = getEtherscanErrorMessage(body);
        if (!isNonRetryableEtherscanError(msg)) {
          stats.retryErrors.push(`http_${response.status}:${msg}`);
          recordProviderFailure(new Error(msg));
          if (attempt < maxAttempts - 1) {
            stats.retries += 1;
            await sleep(jitteredBackoffMs(attempt), options.signal);
            continue;
          }
        }
        recordProviderSuccess();
        return { response, bodyText: text, stats };
      }
      recordProviderSuccess();
      return { response, bodyText: text, stats };
    } catch (error) {
      const elapsedMs = Date.now() - attemptStarted;
      timings.abortTriggeredAt = Date.now();
      timings.requestEndedAt = timings.abortTriggeredAt;
      stats.lastTimings = timings;
      if (error instanceof FetchTimeoutError) {
        logEtherscanTimeoutDiagnostics(timings, attempt + 1);
        options.onTimeout?.({
          attempt: attempt + 1,
          elapsedMs,
          timeoutMs,
          timings,
          hangPhase:
            timings.headersReceivedAt == null
              ? "connect_or_headers"
              : "body_download_or_json_parse",
        });
      }
      if (
        options.signal?.aborted ||
        error instanceof EtherscanNoProgressTimeout ||
        error instanceof EtherscanProviderCircuitOpenError
      ) {
        if (error instanceof EtherscanProviderCircuitOpenError) {
          throw error;
        }
        throw error instanceof EtherscanNoProgressTimeout
          ? error
          : new EtherscanNoProgressTimeout(
              "Etherscan fetch aborted",
              undefined,
              "fetch_start"
            );
      }
      if (error instanceof ProviderCircuitOpenError) {
        throw new EtherscanProviderCircuitOpenError(error.message);
      }
      recordProviderFailure(error);
      const msg = error instanceof Error ? error.message : String(error);
      if (!isTransientFetchError(error) || attempt >= maxAttempts - 1) {
        throw error;
      }
      stats.retries += 1;
      stats.retryErrors.push(msg);
      await sleep(jitteredBackoffMs(attempt), options.signal);
    }
  }

  throw new Error("etherscan_fetch_exhausted_retries");
}
