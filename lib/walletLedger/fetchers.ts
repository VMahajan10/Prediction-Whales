import { fetchWithTimeout } from "@/lib/fetchWithTimeout";
import { mergeOutboundHeaders } from "@/lib/outboundHttp";
import {
  ACTIVITY_API_MAX_ROWS,
  DATA_API_PAGE_SIZE,
  POLYMARKET_DATA_API_BASE,
  TRADES_API_MAX_OFFSET,
  TRADES_API_MAX_ROWS,
} from "@/lib/walletLedger/constants";
import type {
  ActivityApiRow,
  PaginatedFetchResult,
  PositionApiRow,
  TradeApiRow,
} from "@/lib/walletLedger/types";

const JSON_HEADERS = mergeOutboundHeaders({ Accept: "application/json" });

async function fetchDataApiPage<T>(
  path: string,
  wallet: string,
  limit: number,
  offset: number
): Promise<{ rows: T[]; error?: string }> {
  const url = `${POLYMARKET_DATA_API_BASE}${path}?user=${encodeURIComponent(wallet)}&limit=${limit}&offset=${offset}`;
  try {
    const res = await fetchWithTimeout(url, { headers: JSON_HEADERS });
    const text = await res.text();
    if (!res.ok) {
      let message = `HTTP ${res.status}`;
      try {
        const parsed = JSON.parse(text) as { error?: string };
        if (parsed.error) message = parsed.error;
      } catch {
        // ignore
      }
      return { rows: [], error: message };
    }
    const data = JSON.parse(text) as unknown;
    return { rows: Array.isArray(data) ? (data as T[]) : [] };
  } catch (error) {
    return {
      rows: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface PaginateOptions {
  pageSize?: number;
  maxRows?: number;
  maxOffset?: number;
  interPageDelayMs?: number;
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function paginateDataApi<T>(
  path: "/activity" | "/trades",
  wallet: string,
  options: PaginateOptions = {}
): Promise<PaginatedFetchResult<T>> {
  const pageSize = options.pageSize ?? DATA_API_PAGE_SIZE;
  const maxRows =
    options.maxRows ??
    (path === "/activity" ? ACTIVITY_API_MAX_ROWS : TRADES_API_MAX_ROWS);
  const maxOffset =
    options.maxOffset ??
    (path === "/trades" ? TRADES_API_MAX_OFFSET : Number.MAX_SAFE_INTEGER);

  const rows: T[] = [];
  let pagesFetched = 0;
  let maxOffsetReached = 0;
  let truncated = false;
  let error: string | undefined;

  for (let offset = 0; offset <= maxOffset && rows.length < maxRows; offset += pageSize) {
    const page = await fetchDataApiPage<T>(path, wallet, pageSize, offset);
    pagesFetched += 1;
    maxOffsetReached = offset;

    if (page.error) {
      error = page.error;
      if (page.rows.length === 0) {
        truncated = rows.length > 0 || offset > 0;
        break;
      }
    }

    rows.push(...page.rows);

    if (page.rows.length < pageSize) {
      break;
    }

    if (rows.length >= maxRows) {
      truncated = true;
      break;
    }

    if (offset + pageSize > maxOffset) {
      truncated = true;
      break;
    }

    await sleep(options.interPageDelayMs ?? 0);
  }

  if (path === "/activity" && rows.length >= ACTIVITY_API_MAX_ROWS) {
    truncated = true;
  }
  if (path === "/trades" && maxOffsetReached >= TRADES_API_MAX_OFFSET) {
    truncated = true;
  }

  return {
    rows: rows.slice(0, maxRows),
    truncated,
    pagesFetched,
    maxOffsetReached,
    pageSize,
    error,
  };
}

export async function fetchActivityHistory(
  wallet: string,
  options?: PaginateOptions
): Promise<PaginatedFetchResult<ActivityApiRow>> {
  return paginateDataApi<ActivityApiRow>("/activity", wallet, options);
}

export async function fetchTradeHistory(
  wallet: string,
  options?: PaginateOptions
): Promise<PaginatedFetchResult<TradeApiRow>> {
  return paginateDataApi<TradeApiRow>("/trades", wallet, options);
}

export async function fetchPositionsSnapshot(
  wallet: string
): Promise<PositionApiRow[]> {
  const url = `${POLYMARKET_DATA_API_BASE}/positions?user=${encodeURIComponent(wallet)}`;
  try {
    const res = await fetchWithTimeout(url, { headers: JSON_HEADERS });
    if (!res.ok) return [];
    const data = (await res.json()) as unknown;
    return Array.isArray(data) ? (data as PositionApiRow[]) : [];
  } catch {
    return [];
  }
}

/** Lightweight probe for identity resolution (single page each). */
export async function probeWalletHistoryCounts(wallet: string): Promise<{
  activityCount: number;
  tradeCount: number;
  positionsCount: number;
  activityTruncated: boolean;
  tradeTruncated: boolean;
}> {
  const [activity, trades, positions] = await Promise.all([
    fetchDataApiPage<ActivityApiRow>("/activity", wallet, 500, 0),
    fetchDataApiPage<TradeApiRow>("/trades", wallet, 500, 0),
    fetchPositionsSnapshot(wallet),
  ]);

  return {
    activityCount: activity.rows.length,
    tradeCount: trades.rows.length,
    positionsCount: positions.length,
    activityTruncated: activity.rows.length >= 500,
    tradeTruncated: trades.rows.length >= 500,
  };
}
