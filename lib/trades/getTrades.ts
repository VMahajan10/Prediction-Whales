import "server-only";

import { mapWithConcurrency } from "@/lib/clvPriceHistory";
import {
  extractTraderWalletAddress,
  generateUniqueTraderName,
  getUniqueTraderName,
  isAnonymousWalletAddress,
  resolveWhaleIdentity,
  type ResolvedWhaleIdentity,
  type WhaleRegistryStats,
} from "@/lib/whaleIdentityResolver";
import { getPrisma, isPrismaEnabled } from "@/lib/prisma";
import {
  getWhaleAlias,
  needsGeneratedWhalePseudonym,
} from "@/lib/x-agent/getWhaleAlias";
import { KALSHI_TRADER_ALIAS } from "@/lib/trades/whaleAliasConstants";

export {
  KALSHI_TRADER_ALIAS,
  UNATTRIBUTED_TRADER_ALIAS,
  WHALE_TRADER_FALLBACK_ALIAS,
} from "@/lib/trades/whaleAliasConstants";

const WHALE_ALIAS_CONCURRENCY = 8;
/** Aliases are stable once persisted; skip the registry round-trip on repeat views. */
const WHALE_ALIAS_CACHE_TTL_MS = 30 * 60 * 1000;

function whaleAliasCache(): Map<string, { alias: string; at: number }> {
  const g = globalThis as typeof globalThis & {
    __whaleAliasCache?: Map<string, { alias: string; at: number }>;
  };
  if (!g.__whaleAliasCache) g.__whaleAliasCache = new Map();
  return g.__whaleAliasCache;
}

/**
 * One registry query for every uncached wallet. Wallets without a usable pseudonym get
 * the deterministic generated alias immediately; persisting it happens off the request path.
 */
async function prefetchWhaleAliases(wallets: string[]): Promise<void> {
  const cache = whaleAliasCache();
  const now = Date.now();
  const missing = wallets
    .map((w) => normalizeResolvableWallet(w))
    .filter((w): w is string => {
      if (!w) return false;
      const hit = cache.get(w);
      return !hit || now - hit.at >= WHALE_ALIAS_CACHE_TTL_MS;
    });
  if (missing.length === 0 || !isPrismaEnabled()) return;
  const prisma = getPrisma();
  if (!prisma) return;

  let rows: Array<{ walletAddress: string; pseudonym: string | null }>;
  try {
    rows = await prisma.whaleRegistry.findMany({
      where: { walletAddress: { in: missing } },
      select: { walletAddress: true, pseudonym: true },
    });
  } catch {
    return;
  }
  const pseudonymByWallet = new Map(
    rows.map((r) => [r.walletAddress.toLowerCase(), r.pseudonym])
  );

  for (const wallet of missing) {
    const pseudonym = pseudonymByWallet.get(wallet);
    if (pseudonym && !needsGeneratedWhalePseudonym(wallet, pseudonym)) {
      cache.set(wallet, { alias: pseudonym.trim(), at: now });
      continue;
    }
    cache.set(wallet, { alias: generateUniqueTraderName(wallet), at: now });
    void getWhaleAlias(wallet)
      .then((alias) => {
        if (alias) cache.set(wallet, { alias, at: Date.now() });
      })
      .catch(() => undefined);
  }
}

async function getWhaleAliasCached(wallet: string): Promise<string | null> {
  const cache = whaleAliasCache();
  const hit = cache.get(wallet);
  if (hit && Date.now() - hit.at < WHALE_ALIAS_CACHE_TTL_MS) return hit.alias;
  const alias = await getWhaleAlias(wallet);
  if (alias) cache.set(wallet, { alias, at: Date.now() });
  return alias;
}

export type TradeWhaleAliasSource = "polymarket" | "kalshi";

export type TradeWhaleAliasFields = {
  whaleAlias: string;
  /** Server-side display label — always a unique alias or registry name. */
  displayName: string;
  /** Normalized on output; input rows may carry `null` from the database. */
  proxyWallet?: string | null;
};

type AliasEnrichableTrade = {
  id?: string | null;
  transactionHash?: string | null;
  proxyWallet?: string | null;
  wallet?: string | null;
  address?: string | null;
  user?: string | null;
  maker_address?: string | null;
  taker_address?: string | null;
  makerAddress?: string | null;
  takerAddress?: string | null;
  username?: string | null;
  name?: string | null;
  pseudonym?: string | null;
  whaleAlias?: string | null;
  displayName?: string | null;
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
  source: TradeWhaleAliasSource = "polymarket",
  seed?: { id?: string | null; transactionHash?: string | null }
): Promise<string> {
  if (source === "kalshi") return KALSHI_TRADER_ALIAS;

  const wallet = normalizeResolvableWallet(walletAddress);
  if (!wallet) {
    return getUniqueTraderName({
      id: seed?.id,
      transactionHash: seed?.transactionHash,
    });
  }

  const alias = await getWhaleAliasCached(wallet);
  return alias ?? generateUniqueTraderName(wallet);
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

/** Attach `whaleAlias`, `displayName`, and normalized `proxyWallet` to every trade. */
export async function enrichTradesWithWhaleAlias<T extends AliasEnrichableTrade>(
  trades: T[]
): Promise<Array<T & TradeWhaleAliasFields>> {
  const wallets = Array.from(
    new Set(
      trades
        .filter((trade) => (trade.source ?? "polymarket") !== "kalshi")
        .map((trade) => extractTraderWalletAddress(trade))
        .filter((wallet): wallet is string => Boolean(wallet))
    )
  );

  await prefetchWhaleAliases(wallets);
  const aliasByWallet = new Map<string, string>();
  await mapWithConcurrency(wallets, WHALE_ALIAS_CONCURRENCY, async (wallet) => {
    aliasByWallet.set(wallet, await resolveTradeWhaleAlias(wallet, "polymarket"));
  });

  return trades.map((trade): T & TradeWhaleAliasFields => {
    const proxyWallet = extractTraderWalletAddress(trade);
    const source = trade.source ?? "polymarket";

    if (source === "kalshi") {
      return {
        ...trade,
        proxyWallet,
        whaleAlias: KALSHI_TRADER_ALIAS,
        displayName: KALSHI_TRADER_ALIAS,
      };
    }

    const whaleAlias = proxyWallet
      ? aliasByWallet.get(proxyWallet) ?? generateUniqueTraderName(proxyWallet)
      : getUniqueTraderName({
          id: trade.id,
          transactionHash: trade.transactionHash,
          username: trade.username,
          name: trade.name,
          pseudonym: trade.pseudonym ?? trade.whaleIdentity?.pseudonym,
          whaleAlias: trade.whaleAlias,
          displayName: trade.displayName,
        });

    const displayName = getUniqueTraderName({
      proxyWallet,
      id: trade.id,
      transactionHash: trade.transactionHash,
      username: trade.username,
      name: trade.name,
      pseudonym: trade.pseudonym ?? trade.whaleIdentity?.pseudonym,
      whaleAlias,
      displayName: trade.displayName,
    });

    return {
      ...trade,
      proxyWallet,
      whaleAlias: displayName,
      displayName,
    };
  });
}
