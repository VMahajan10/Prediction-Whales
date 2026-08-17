/**
 * Shared ingestion polling / fetch-size knobs for trade polling workers and API routes.
 * Override via env on Render to tune bandwidth without code changes.
 */
function readPositiveIntEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/** Minimum interval between Kalshi upstream REST fetches (default 60s). */
export const KALSHI_TRADES_POLL_MS = readPositiveIntEnv(
  "KALSHI_TRADES_POLL_MS",
  60_000
);

/** Kalshi trades page size per upstream request (default 100). */
export const KALSHI_TRADES_PAGE_LIMIT = readPositiveIntEnv(
  "KALSHI_TRADES_PAGE_LIMIT",
  100
);

/** Max Kalshi pages on cold fetch (default 5). */
export const KALSHI_TRADES_MAX_PAGES_INITIAL = readPositiveIntEnv(
  "KALSHI_TRADES_MAX_PAGES_INITIAL",
  5
);

/** Max Kalshi pages when `min_ts` is provided (default 2). */
export const KALSHI_TRADES_MAX_PAGES_INCREMENTAL = readPositiveIntEnv(
  "KALSHI_TRADES_MAX_PAGES_INCREMENTAL",
  2
);

/** Polymarket Data API trades limit for lightweight polling routes (default 20). */
export const POLYMARKET_TRADES_POLL_LIMIT = readPositiveIntEnv(
  "POLYMARKET_TRADES_POLL_LIMIT",
  20
);

/** In-memory metadata cache TTL for registry / wallet lookups (default 5 min). */
export const METADATA_CACHE_TTL_MS = readPositiveIntEnv(
  "METADATA_CACHE_TTL_MS",
  5 * 60 * 1000
);

/** Client Kalshi poll interval exposed to the browser hook (default 60s). */
export const KALSHI_CLIENT_POLL_MS = readPositiveIntEnv(
  "KALSHI_CLIENT_POLL_MS",
  60_000
);
