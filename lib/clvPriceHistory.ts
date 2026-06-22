import { Redis } from "@upstash/redis";
import {
  fetchWithTimeout,
  isFetchTimeoutError,
  PAGE_FETCH_TIMEOUT_MS,
} from "./fetchWithTimeout";

const CLOB_PRICES_URL = "https://clob.polymarket.com/prices-history";
const CLV_LINE_KEY_PREFIX = "clv:line:v1:";
/** Effectively permanent — price history is immutable post-resolution. */
const CLV_LINE_TTL_SEC = 60 * 60 * 24 * 365;

export const CLV_CONSTANTS = {
  COLLAPSE_NEAR: 0.03,
  UNCOLLAPSED_MIN: 0.1,
  UNCOLLAPSED_MAX: 0.9,
  FRESHNESS_MAX_H: 24,
  MIN_POINTS: 5,
  COVERAGE_FLOOR: 5,
  WEIGHTED_DIFF_THRESHOLD: 0.02,
  FETCH_CONCURRENCY: 8,
} as const;

export interface PricePoint {
  t: number;
  p: number;
}

export type PriceHistoryFetchError =
  | "http"
  | "network"
  | "timeout"
  | "invalid_response";

export type PriceHistoryFetchResult =
  | { ok: true; points: PricePoint[] }
  | { ok: false; error: PriceHistoryFetchError; httpStatus?: number };

export type ClosingLineExclusionReason =
  | "ephemeral"
  | "no_history"
  | "incomplete"
  | "always_collapsed"
  | "stale_line"
  | "bad_entry";

export interface CachedClosingLine {
  closingLine: number | null;
  settlement: 0 | 1;
  freshnessHours: number | null;
  valid: boolean;
  reason?: ClosingLineExclusionReason;
}

export interface ClosingLineDetection {
  avgPrice: number;
  settlement: 0 | 1;
  closingLine: number | null;
  clv: number | null;
  freshnessHours: number | null;
  valid: boolean;
  reason?: ClosingLineExclusionReason;
}

export interface ClosingLineResult extends ClosingLineDetection {
  asset: string;
  title: string;
  totalBought: number;
  evDollars?: number;
}

let redis: Redis | null = null;

function isRedisEnabled(): boolean {
  return !!(
    process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
  );
}

function getRedis(): Redis | null {
  if (!isRedisEnabled()) return null;
  if (!redis) {
    redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL!,
      token: process.env.UPSTASH_REDIS_REST_TOKEN!,
    });
  }
  return redis;
}

function nearSettlement(p: number, settled: 0 | 1): boolean {
  return Math.abs(p - settled) <= CLV_CONSTANTS.COLLAPSE_NEAR;
}

function uncollapsed(p: number): boolean {
  return (
    p >= CLV_CONSTANTS.UNCOLLAPSED_MIN && p <= CLV_CONSTANTS.UNCOLLAPSED_MAX
  );
}

function median3(series: PricePoint[], clIdx: number): number {
  const start = Math.max(0, clIdx - 2);
  const prices = series.slice(start, clIdx + 1).map((pt) => pt.p);
  prices.sort((a, b) => a - b);
  const mid = Math.floor(prices.length / 2);
  return prices.length % 2 === 0
    ? (prices[mid - 1] + prices[mid]) / 2
    : prices[mid];
}

function invalidDetection(
  settled: 0 | 1,
  avgPrice: number,
  reason: ClosingLineExclusionReason,
  extras: Partial<ClosingLineDetection> = {}
): ClosingLineDetection {
  return {
    avgPrice,
    settlement: settled,
    closingLine: extras.closingLine ?? null,
    clv: null,
    freshnessHours: extras.freshnessHours ?? null,
    valid: false,
    reason,
  };
}

/** Pure closing-line detection — unit-testable, no I/O. */
export function detectClosingLine(
  series: PricePoint[],
  settled: 0 | 1,
  avgPrice: number
): ClosingLineDetection {
  if (!avgPrice || avgPrice <= 0) {
    return invalidDetection(settled, avgPrice, "bad_entry");
  }

  if (!series?.length) {
    return invalidDetection(settled, avgPrice, "no_history");
  }

  if (series.length < CLV_CONSTANTS.MIN_POINTS) {
    return invalidDetection(settled, avgPrice, "incomplete");
  }

  let collapseStart = series.length;
  for (let i = series.length - 1; i >= 0; i--) {
    if (nearSettlement(series[i].p, settled)) {
      collapseStart = i;
    } else {
      break;
    }
  }

  if (collapseStart === 0) {
    return invalidDetection(settled, avgPrice, "always_collapsed");
  }

  if (collapseStart === series.length) {
    return invalidDetection(settled, avgPrice, "incomplete");
  }

  let clIdx = -1;
  for (let i = collapseStart - 1; i >= 0; i--) {
    if (uncollapsed(series[i].p)) {
      clIdx = i;
      break;
    }
  }

  if (clIdx === -1) {
    return invalidDetection(settled, avgPrice, "always_collapsed");
  }

  const closingLine = median3(series, clIdx);
  const tCl = series[clIdx].t;
  const tCommit = series[collapseStart].t;
  const freshnessHours = (tCommit - tCl) / 3600;

  if (freshnessHours > CLV_CONSTANTS.FRESHNESS_MAX_H) {
    return invalidDetection(settled, avgPrice, "stale_line", {
      closingLine,
      freshnessHours,
    });
  }

  return {
    avgPrice,
    settlement: settled,
    closingLine,
    clv: closingLine - avgPrice,
    freshnessHours,
    valid: true,
  };
}

export async function getCachedClosingLine(
  asset: string
): Promise<CachedClosingLine | null> {
  const client = getRedis();
  if (!client) return null;

  try {
    const key = `${CLV_LINE_KEY_PREFIX}${asset}`;
    const raw = await client.get<CachedClosingLine | string>(key);
    if (!raw) return null;
    return typeof raw === "string"
      ? (JSON.parse(raw) as CachedClosingLine)
      : raw;
  } catch (err) {
    console.warn("[clvPriceHistory] cache read failed:", err);
    return null;
  }
}

export async function setCachedClosingLine(
  asset: string,
  line: CachedClosingLine
): Promise<void> {
  const client = getRedis();
  if (!client) return;

  try {
    const key = `${CLV_LINE_KEY_PREFIX}${asset}`;
    await client.set(key, line, { ex: CLV_LINE_TTL_SEC });
  } catch (err) {
    console.warn("[clvPriceHistory] cache write failed:", err);
  }
}

export async function fetchPriceHistory(
  asset: string
): Promise<PriceHistoryFetchResult> {
  const url = `${CLOB_PRICES_URL}?market=${encodeURIComponent(asset)}&interval=max&fidelity=60`;
  try {
    const res = await fetchWithTimeout(url, {
      timeoutMs: PAGE_FETCH_TIMEOUT_MS,
      next: { revalidate: 86400 },
    });
    if (!res.ok) {
      return { ok: false, error: "http", httpStatus: res.status };
    }

    const data: unknown = await res.json();
    if (
      !data ||
      typeof data !== "object" ||
      !Array.isArray((data as { history?: unknown }).history)
    ) {
      return { ok: false, error: "invalid_response" };
    }

    const history = (data as { history: Array<{ t?: number; p?: number }> })
      .history;
    const points: PricePoint[] = [];
    for (const pt of history) {
      if (typeof pt.t === "number" && typeof pt.p === "number") {
        points.push({ t: pt.t, p: pt.p });
      }
    }

    return { ok: true, points };
  } catch (err) {
    if (isFetchTimeoutError(err)) {
      return { ok: false, error: "timeout" };
    }
    return { ok: false, error: "network" };
  }
}

/** Per-asset closing line (wallet-agnostic — shared across all whales). */
export async function resolveClosingLine(
  asset: string,
  settled: 0 | 1,
  avgPrice: number
): Promise<ClosingLineDetection> {
  const cached = await getCachedClosingLine(asset);
  if (cached) {
    const clv =
      cached.valid && cached.closingLine != null
        ? cached.closingLine - avgPrice
        : null;
    return {
      avgPrice,
      settlement: cached.settlement,
      closingLine: cached.closingLine,
      clv,
      freshnessHours: cached.freshnessHours,
      valid: cached.valid,
      reason: cached.reason,
    };
  }

  const fetched = await fetchPriceHistory(asset);
  if (!fetched.ok) {
    console.warn(
      `[clvPriceHistory] price history fetch failed for ${asset}: ${fetched.error}${
        fetched.httpStatus != null ? ` (${fetched.httpStatus})` : ""
      }`
    );
    // Do not cache — transient failures must retry on the next request.
    return invalidDetection(settled, avgPrice, "no_history");
  }

  if (fetched.points.length === 0) {
    const result = invalidDetection(settled, avgPrice, "no_history");
    await setCachedClosingLine(asset, {
      closingLine: null,
      settlement: settled,
      freshnessHours: null,
      valid: false,
      reason: "no_history",
    });
    return result;
  }

  const detected = detectClosingLine(fetched.points, settled, avgPrice);
  await setCachedClosingLine(asset, {
    closingLine: detected.closingLine,
    settlement: detected.settlement,
    freshnessHours: detected.freshnessHours,
    valid: detected.valid,
    reason: detected.reason,
  });
  return detected;
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  if (!items.length) return [];
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      results[i] = await fn(items[i]);
    }
  }

  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    () => worker()
  );
  await Promise.all(workers);
  return results;
}
