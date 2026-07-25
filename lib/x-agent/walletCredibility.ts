import type { WhaleRegistry } from "@/lib/crossmarket/store/schema";
import {
  fetchClosedPositions,
  isEphemeralClosedPosition,
} from "@/lib/polymarket";
import {
  MIN_WALLET_AVG_EV_DECIMAL,
  MIN_WALLET_RESOLVED_BETS,
} from "@/lib/x-agent/gateMetrics";
import { calculateAvgEv, type ResolvedBet } from "@/lib/x-agent/math";
import {
  findWhaleByWallet,
  findWhaleByWalletCaseInsensitive,
  formatWalletPseudonym,
  isAnonymousWalletAddress,
  normalizeWalletAddress,
  upsertWhaleRegistry,
} from "@/lib/x-agent/whaleRegistryDb";

export interface WalletCredibilityStats {
  resolvedBetsCount: number;
  avgEv: number;
  winRate: number;
  closedCount: number;
}

export interface WalletCredibilityResolution {
  whale: WhaleRegistry | null;
  source:
    | "registry"
    | "polymarket_api"
    | "low_credibility_cache"
    | "anonymous"
    | "unavailable";
  stats?: WalletCredibilityStats;
}

const LOW_CREDIBILITY_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

type LowCredibilityCacheEntry = {
  expiresAt: number;
  stats: WalletCredibilityStats;
};

type GlobalWithLowCredibilityCache = typeof globalThis & {
  __xAgentLowCredibilityCache?: Map<string, LowCredibilityCacheEntry>;
};

function lowCredibilityCache(): Map<string, LowCredibilityCacheEntry> {
  const globalRef = globalThis as GlobalWithLowCredibilityCache;
  if (!globalRef.__xAgentLowCredibilityCache) {
    globalRef.__xAgentLowCredibilityCache = new Map();
  }
  return globalRef.__xAgentLowCredibilityCache;
}

function readLowCredibilityCache(
  wallet: string
): LowCredibilityCacheEntry | null {
  const key = normalizeWalletAddress(wallet);
  const entry = lowCredibilityCache().get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    lowCredibilityCache().delete(key);
    return null;
  }
  return entry;
}

function writeLowCredibilityCache(
  wallet: string,
  stats: WalletCredibilityStats
): void {
  lowCredibilityCache().set(normalizeWalletAddress(wallet), {
    expiresAt: Date.now() + LOW_CREDIBILITY_CACHE_TTL_MS,
    stats,
  });
}

export function walletMeetsCredibilityCriteria(stats: WalletCredibilityStats): boolean {
  return (
    stats.resolvedBetsCount >= MIN_WALLET_RESOLVED_BETS &&
    stats.avgEv >= MIN_WALLET_AVG_EV_DECIMAL
  );
}

export function closedPositionsToResolvedBets(
  closedPositions: unknown[]
): ResolvedBet[] {
  const bets: ResolvedBet[] = [];

  for (const raw of closedPositions) {
    const position = raw as Record<string, unknown>;
    if (
      isEphemeralClosedPosition({
        slug: position.slug as string | undefined,
        eventSlug: position.eventSlug as string | undefined,
        title: position.title as string | undefined,
      })
    ) {
      continue;
    }

    const entryPrice = Number(position.avgPrice);
    if (!Number.isFinite(entryPrice) || entryPrice <= 0) continue;

    const realizedPnl = Number(position.realizedPnl ?? 0);
    if (!Number.isFinite(realizedPnl) || realizedPnl === 0) continue;

    bets.push({
      entryPrice,
      payout: realizedPnl > 0 ? 1 : 0,
    });
  }

  return bets;
}

export function computeWalletCredibilityStats(
  closedPositions: unknown[]
): WalletCredibilityStats {
  const resolvedBets = closedPositionsToResolvedBets(closedPositions);
  const closedCount = resolvedBets.length;
  const wins = resolvedBets.filter((bet) => bet.payout > 0).length;

  return {
    resolvedBetsCount: closedCount,
    avgEv: calculateAvgEv(resolvedBets),
    winRate: closedCount > 0 ? wins / closedCount : 0,
    closedCount,
  };
}

function buildStubWhale(
  wallet: string,
  stats: WalletCredibilityStats
): WhaleRegistry {
  const walletAddress = normalizeWalletAddress(wallet);
  const now = new Date();

  return {
    walletAddress,
    pseudonym: formatWalletPseudonym(walletAddress),
    resolvedBetsCount: stats.resolvedBetsCount,
    avgEv: stats.avgEv,
    winRate: stats.winRate,
    avgStakeNotional: 0,
    postedCount30d: 0,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Resolve wallet credibility for post-queue gates.
 * 1. Case-insensitive registry lookup
 * 2. Low-credibility cache (skip repeat Polymarket fetches)
 * 3. Polymarket Data API closed-positions history
 * 4. Registry re-check after API (race with concurrent upserts)
 */
export async function resolveWhaleForCredibilityGate(
  wallet: string
): Promise<WalletCredibilityResolution> {
  if (isAnonymousWalletAddress(wallet)) {
    return { whale: null, source: "anonymous" };
  }

  const walletAddress = normalizeWalletAddress(wallet);
  if (!walletAddress) {
    return { whale: null, source: "unavailable" };
  }

  const fromRegistry = await findWhaleByWalletCaseInsensitive(walletAddress);
  if (fromRegistry) {
    return { whale: fromRegistry, source: "registry" };
  }

  const cached = readLowCredibilityCache(walletAddress);
  if (cached) {
    console.log(
      "[x-agent/walletCredibility] low-credibility cache hit",
      walletAddress
    );
    return {
      whale: buildStubWhale(walletAddress, cached.stats),
      source: "low_credibility_cache",
      stats: cached.stats,
    };
  }

  let closedPositions: unknown[] = [];
  try {
    closedPositions = await fetchClosedPositions(walletAddress);
  } catch (error) {
    console.warn("[x-agent/walletCredibility] Polymarket fetch failed", {
      wallet: walletAddress,
      error: error instanceof Error ? error.message : error,
    });
    const retryRegistry = await findWhaleByWalletCaseInsensitive(walletAddress);
    if (retryRegistry) {
      return { whale: retryRegistry, source: "registry" };
    }
    return { whale: null, source: "unavailable" };
  }

  const registryAfterFetch =
    await findWhaleByWalletCaseInsensitive(walletAddress);
  if (registryAfterFetch) {
    return { whale: registryAfterFetch, source: "registry" };
  }

  const stats = computeWalletCredibilityStats(closedPositions);

  if (walletMeetsCredibilityCriteria(stats)) {
    const upserted = await upsertWhaleRegistry({
      walletAddress,
      resolvedBetsCount: stats.resolvedBetsCount,
      avgEv: stats.avgEv,
      winRate: stats.winRate,
    });

    if (upserted) {
      console.log("[x-agent/walletCredibility] upserted credible wallet", {
        wallet: walletAddress,
        resolvedBetsCount: stats.resolvedBetsCount,
        avgEv: stats.avgEv,
      });
      return {
        whale: upserted,
        source: "polymarket_api",
        stats,
      };
    }

    const fallback = await findWhaleByWallet(walletAddress);
    if (fallback) {
      return { whale: fallback, source: "registry", stats };
    }
  } else {
    writeLowCredibilityCache(walletAddress, stats);
    console.log("[x-agent/walletCredibility] cached low-credibility wallet", {
      wallet: walletAddress,
      resolvedBetsCount: stats.resolvedBetsCount,
      avgEv: stats.avgEv,
    });
  }

  return {
    whale: buildStubWhale(walletAddress, stats),
    source: walletMeetsCredibilityCriteria(stats)
      ? "polymarket_api"
      : "low_credibility_cache",
    stats,
  };
}

/** Test helper — clear in-process low-credibility cache. */
export function clearLowCredibilityCacheForTests(): void {
  lowCredibilityCache().clear();
}
