import "server-only";

import { mapWithConcurrency } from "@/lib/clvPriceHistory";
import {
  generateDeterministicWhalePseudonym,
  isAnonymousWalletAddress,
  resolveWhaleIdentity,
  type ResolvedWhaleIdentity,
  type WhaleRegistryStats,
} from "@/lib/whaleIdentityResolver";
import { getWhaleAlias } from "@/lib/x-agent/getWhaleAlias";
import {
  KALSHI_TRADER_ALIAS,
  UNATTRIBUTED_TRADER_ALIAS,
} from "@/lib/trades/whaleAliasConstants";

export {
  KALSHI_TRADER_ALIAS,
  UNATTRIBUTED_TRADER_ALIAS,
} from "@/lib/trades/whaleAliasConstants";

const WHALE_ALIAS_CONCURRENCY = 8;

export type TradeWhaleAliasSource = "polymarket" | "kalshi";

export type TradeWhaleAliasFields = {
  whaleAlias: string;
  proxyWallet?: string;
};

type AliasEnrichableTrade = {
  proxyWallet?: string | null;
  source?: TradeWhaleAliasSource;
  whaleIdentity?: ResolvedWhaleIdentity;
};

function normalizeResolvableWallet(
  walletAddress: string | null | undefined
): string | undefined {
  const wallet = walletAddress?.trim().toLowerCase();
  if (!wallet || isAnonymousWalletAddress(wallet)) return undefined;
  if (!/^0x[a-f0-9]{40}$/.test(wallet)) return undefined;
  return wallet;
}

/**
 * Resolve a stable whale alias for API responses.
 * Persists auto-generated pseudonyms via `getWhaleAlias` when a wallet is known.
 */
export async function resolveTradeWhaleAlias(
  walletAddress: string | null | undefined,
  source: TradeWhaleAliasSource = "polymarket"
): Promise<string> {
  if (source === "kalshi") return KALSHI_TRADER_ALIAS;

  const wallet = normalizeResolvableWallet(walletAddress);
  if (!wallet) return UNATTRIBUTED_TRADER_ALIAS;

  const alias = await getWhaleAlias(wallet);
  return alias ?? generateDeterministicWhalePseudonym(wallet);
}

export function buildWhaleIdentityForAlias(
  walletAddress: string | null | undefined,
  whaleAlias: string,
  stats?: WhaleRegistryStats | null
): ResolvedWhaleIdentity {
  const wallet = normalizeResolvableWallet(walletAddress);
  if (!wallet) {
    return resolveWhaleIdentity(null);
  }

  return resolveWhaleIdentity(wallet, whaleAlias, stats ?? null);
}

/** Attach `whaleAlias` (and normalized `proxyWallet`) to every trade in a batch. */
export async function enrichTradesWithWhaleAlias<T extends AliasEnrichableTrade>(
  trades: T[]
): Promise<Array<T & TradeWhaleAliasFields>> {
  const wallets = Array.from(
    new Set(
      trades
        .filter((trade) => (trade.source ?? "polymarket") !== "kalshi")
        .map((trade) => normalizeResolvableWallet(trade.proxyWallet))
        .filter((wallet): wallet is string => Boolean(wallet))
    )
  );

  const aliasByWallet = new Map<string, string>();
  await mapWithConcurrency(wallets, WHALE_ALIAS_CONCURRENCY, async (wallet) => {
    aliasByWallet.set(wallet, await resolveTradeWhaleAlias(wallet, "polymarket"));
  });

  return trades.map((trade) => {
    const source = trade.source ?? "polymarket";
    if (source === "kalshi") {
      return {
        ...trade,
        whaleAlias: KALSHI_TRADER_ALIAS,
      };
    }

    const proxyWallet = normalizeResolvableWallet(trade.proxyWallet);
    const whaleAlias = proxyWallet
      ? aliasByWallet.get(proxyWallet) ??
        generateDeterministicWhalePseudonym(proxyWallet)
      : UNATTRIBUTED_TRADER_ALIAS;

    return {
      ...trade,
      ...(proxyWallet ? { proxyWallet } : {}),
      whaleAlias,
    };
  });
}
