/** Polymarket Data API base URL (read-only prototype). */
export const POLYMARKET_DATA_API_BASE = "https://data-api.polymarket.com";

/** Gamma API base URL for market resolution metadata. */
export const POLYMARKET_GAMMA_API_BASE = "https://gamma-api.polymarket.com";

/** Default page size for paginated Data API fetches. */
export const DATA_API_PAGE_SIZE = 500;

/** Observed hard cap: closed-positions returns at most ~50 rows (reconciliation only). */
export const CLOSED_POSITIONS_API_MAX_ROWS = 50;

/** Observed hard cap: activity stops returning new rows around ~5,500. */
export const ACTIVITY_API_MAX_ROWS = 5_500;

/** Observed max offset for /trades before API error. */
export const TRADES_API_MAX_OFFSET = 10_000;

/** Maximum trades retrievable: offset 10,000 + one page of 500. */
export const TRADES_API_MAX_ROWS = TRADES_API_MAX_OFFSET + DATA_API_PAGE_SIZE;

/** Share balance tolerance for "fully exited" detection. */
export const SHARE_BALANCE_EPSILON = 1e-4;

/** Minimum combined activity+trade rows to treat an address as materially historical. */
export const MEANINGFUL_HISTORY_ROW_THRESHOLD = 5;

/** Two candidates within this ratio are flagged ambiguous. */
export const IDENTITY_AMBIGUITY_RATIO = 0.8;
