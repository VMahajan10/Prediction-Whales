import { resolveWalletByTradeHash } from "@/lib/polymarket";
import { METADATA_CACHE_TTL_MS } from "@/lib/ingestionPollConfig";
import {
  normalizeWalletAddress,
  resolveTraderFromReceiptLogs,
  type TradeResolveContext,
} from "@/lib/resolveWhaleWalletEconomic";

const POLYGON_RPC_URLS = [
  "https://polygon-bor-rpc.publicnode.com",
  "https://polygon.drpc.org",
];

export type WalletResolveSource =
  | "data-api-trusted"
  | "onchain-economic"
  | "data-api-asset"
  | "data-api-global"
  | null;

type WalletResolutionCacheEntry = {
  expiresAt: number;
  wallet: string | null;
  source: WalletResolveSource;
};

const walletResolutionCache = new Map<string, WalletResolutionCacheEntry>();

export function clearWalletResolutionCache(): void {
  walletResolutionCache.clear();
}

function walletResolutionCacheKey(
  hash: string,
  options?: ResolveWalletForTradeOptions
): string {
  const asset = options?.assetId ?? "";
  const side = options?.side ?? "";
  const size = options?.sizeShares ?? "";
  const trusted = options?.trustedApiProxyWallet ?? "";
  return `${hash.toLowerCase()}:${asset}:${side}:${size}:${trusted}`;
}

interface TxLog {
  address: string;
  topics: string[];
  data: string;
}

async function fetchTransactionReceipt(
  hash: string
): Promise<{ logs: TxLog[] } | null> {
  for (const rpc of POLYGON_RPC_URLS) {
    try {
      const res = await fetch(rpc, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_getTransactionReceipt",
          params: [hash],
        }),
        next: { revalidate: 0 },
      });
      const json = (await res.json()) as {
        result?: { logs?: TxLog[] };
      };
      if (json.result?.logs) {
        return { logs: json.result.logs };
      }
    } catch {
      continue;
    }
  }
  return null;
}

export interface ResolveWalletForTradeOptions extends TradeResolveContext {
  /**
   * Upstream Polymarket Data API proxyWallet for this trade.
   * When valid, must not be overwritten by weaker onchain heuristics.
   */
  trustedApiProxyWallet?: string | null;
}

/** Economic OrderFilled match — no CTF topic voting. */
export async function resolveWalletOnChain(
  hash: string,
  options?: TradeResolveContext
): Promise<string | null> {
  const receipt = await fetchTransactionReceipt(hash);
  if (!receipt?.logs?.length) return null;

  const result = resolveTraderFromReceiptLogs(receipt.logs, {
    assetId: options?.assetId,
    side: options?.side,
    sizeShares: options?.sizeShares,
  });
  return result.wallet;
}

/**
 * Trader identity resolution with explicit evidence precedence:
 * 1. Trusted upstream API proxyWallet
 * 2. Economic OrderFilled match (asset + side + optional size)
 * 3. Data API hash lookup fallback
 */
export async function resolveWalletForTrade(
  hash: string,
  options?: ResolveWalletForTradeOptions
): Promise<{ wallet: string | null; source: WalletResolveSource }> {
  const cacheKey = walletResolutionCacheKey(hash, options);
  const cached = walletResolutionCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { wallet: cached.wallet, source: cached.source };
  }

  const remember = (
    wallet: string | null,
    source: WalletResolveSource
  ): { wallet: string | null; source: WalletResolveSource } => {
    walletResolutionCache.set(cacheKey, {
      wallet,
      source,
      expiresAt: Date.now() + METADATA_CACHE_TTL_MS,
    });
    return { wallet, source };
  };

  const trusted = normalizeWalletAddress(options?.trustedApiProxyWallet ?? "");
  if (trusted) {
    return remember(trusted, "data-api-trusted");
  }

  const onchain = await resolveWalletOnChain(hash, options);
  if (onchain) {
    return remember(onchain, "onchain-economic");
  }

  const fromApi = await resolveWalletByTradeHash(hash, options?.assetId);
  if (fromApi) {
    return remember(
      fromApi,
      options?.assetId ? "data-api-asset" : "data-api-global"
    );
  }

  return remember(null, null);
}
