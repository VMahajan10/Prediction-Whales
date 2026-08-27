/** Shared Polygon RPC endpoints (same defaults as resolveWhaleWallet). */
export const POLYGON_RPC_URLS = [
  process.env.POLYGON_RPC_URL?.trim(),
  "https://polygon-bor-rpc.publicnode.com",
  "https://polygon.drpc.org",
].filter((url): url is string => Boolean(url));
