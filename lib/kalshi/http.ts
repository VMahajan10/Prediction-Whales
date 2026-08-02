import { fetchWithTimeout } from "@/lib/fetchWithTimeout";

export const KALSHI_API = "https://api.elections.kalshi.com/trade-api/v2";

/** Pause between sequential ticker/series/page iterations during market sweeps. */
export const KALSHI_BATCH_DELAY_MS = 100;

export const MAX_KALSHI_CONCURRENT = 5;

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_ATTEMPTS = 5;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let activeKalshiRequests = 0;
const kalshiWaitQueue: Array<() => void> = [];

function acquireKalshiSlot(): Promise<void> {
  if (activeKalshiRequests < MAX_KALSHI_CONCURRENT) {
    activeKalshiRequests += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    kalshiWaitQueue.push(() => {
      activeKalshiRequests += 1;
      resolve();
    });
  });
}

function releaseKalshiSlot(): void {
  activeKalshiRequests -= 1;
  const next = kalshiWaitQueue.shift();
  if (next) next();
}

export async function withKalshiConcurrencyLimit<T>(
  fn: () => Promise<T>
): Promise<T> {
  await acquireKalshiSlot();
  try {
    return await fn();
  } finally {
    releaseKalshiSlot();
  }
}

export interface KalshiFetchOptions extends RequestInit {
  timeoutMs?: number;
  label?: string;
  maxAttempts?: number;
}

function kalshiUrl(pathOrUrl: string): string {
  if (pathOrUrl.startsWith("http")) return pathOrUrl;
  return `${KALSHI_API}${pathOrUrl.startsWith("/") ? pathOrUrl : `/${pathOrUrl}`}`;
}

function retryDelayMs(
  attempt: number,
  retryAfterHeader: string | null
): number {
  const retryAfterSec = Number(retryAfterHeader ?? "0");
  if (Number.isFinite(retryAfterSec) && retryAfterSec > 0) {
    return Math.min(30_000, retryAfterSec * 1000);
  }
  return Math.min(30_000, 500 * 2 ** attempt);
}

/**
 * Rate-limited Kalshi REST fetch with exponential backoff on HTTP 429.
 * All Kalshi REST traffic should go through this helper.
 */
export async function kalshiFetch(
  pathOrUrl: string,
  options: KalshiFetchOptions = {}
): Promise<Response> {
  const url = kalshiUrl(pathOrUrl);
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    label = pathOrUrl,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    headers,
    ...init
  } = options;

  return withKalshiConcurrencyLimit(async () => {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const res = await fetchWithTimeout(url, {
          ...init,
          timeoutMs,
          headers: {
            Accept: "application/json",
            "User-Agent": "MarketPulse/1.0",
            ...(headers as Record<string, string> | undefined),
          },
        });

        if (res.status === 429) {
          const delayMs = retryDelayMs(attempt, res.headers.get("retry-after"));
          console.warn(
            `[kalshi] rate limited (429) ${label}; retry ${attempt + 1}/${maxAttempts} in ${delayMs}ms`
          );
          if (attempt + 1 < maxAttempts) {
            await sleep(delayMs);
            continue;
          }
        }

        return res;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt + 1 < maxAttempts) {
          const delayMs = retryDelayMs(attempt, null);
          console.warn(
            `[kalshi] fetch error ${label} attempt ${attempt + 1}/${maxAttempts}: ${lastError.message}; retry in ${delayMs}ms`
          );
          await sleep(delayMs);
        }
      }
    }

    throw lastError ?? new Error(`Kalshi fetch failed: ${label}`);
  });
}
