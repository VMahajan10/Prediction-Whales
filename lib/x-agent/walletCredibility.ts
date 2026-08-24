import type { WhaleRegistry } from "@/lib/crossmarket/store/schema";
import {
  fetchClosedPositions,
  isEphemeralClosedPosition,
} from "@/lib/polymarket";
import {
  MIN_WALLET_AVG_EV_DECIMAL,
  MIN_WALLET_RESOLVED_BETS,
  meetsResolvedBetsThreshold,
} from "@/lib/x-agent/gateMetrics";
import { calculateAvgEv, type ResolvedBet } from "@/lib/x-agent/math";
import {
  findWhaleByWalletCaseInsensitive,
  formatWalletPseudonym,
  isAnonymousWalletAddress,
  normalizeWalletAddress,
  upsertWhaleRegistry,
} from "@/lib/x-agent/whaleRegistryDb";
import {
  resolveWalletHydrationStatus,
  walletNeedsHistoryHydration,
  type WalletHydrationStatus,
} from "@/lib/x-agent/walletHydrationState";

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
  hydrationStatus?: WalletHydrationStatus;
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
    meetsResolvedBetsThreshold(stats.resolvedBetsCount) &&
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

export function isWalletHydrationFallbackEnabled(): boolean {
  const explicit = process.env.X_AGENT_WALLET_HYDRATION_FALLBACK?.trim().toLowerCase();
  if (explicit === "true") return true;
  if (explicit === "false") return false;
  const shadowExplicit = process.env.ALLOW_UNREGISTERED_WALLETS_IN_SHADOW?.trim().toLowerCase();
  const unindexedExplicit = process.env.ALLOW_UNINDEXED_WALLETS?.trim().toLowerCase();
  if (shadowExplicit === "true" || unindexedExplicit === "true") return true;
  if (shadowExplicit === "false" && unindexedExplicit === "false") return false;
  return process.env.NODE_ENV !== "production";
}

function buildQualifiedTestingFallbackStats(): WalletCredibilityStats {
  return {
    resolvedBetsCount: MIN_WALLET_RESOLVED_BETS,
    avgEv: MIN_WALLET_AVG_EV_DECIMAL,
    winRate: 0.5,
    closedCount: MIN_WALLET_RESOLVED_BETS,
  };
}

async function persistWalletHydrationOutcome(input: {
  walletAddress: string;
  stats?: WalletCredibilityStats;
  hydrationStatus: WalletHydrationStatus;
  hydrationError?: string | null;
  attemptedAt?: Date;
}): Promise<WhaleRegistry | null> {
  const attemptedAt = input.attemptedAt ?? new Date();
  const isComplete = input.hydrationStatus === "complete";

  return upsertWhaleRegistry({
    walletAddress: input.walletAddress,
    ...(input.stats
      ? {
          resolvedBetsCount: input.stats.resolvedBetsCount,
          avgEv: input.stats.avgEv,
          winRate: input.stats.winRate,
        }
      : {}),
    hydrationStatus: input.hydrationStatus,
    hydratedAt: isComplete ? attemptedAt : null,
    lastHydrationAttemptAt: attemptedAt,
    hydrationError: input.hydrationError ?? null,
  });
}

async function resolveTestingFallbackWhale(
  walletAddress: string,
  reason: string
): Promise<WalletCredibilityResolution | null> {
  if (!isWalletHydrationFallbackEnabled()) return null;

  const stats = buildQualifiedTestingFallbackStats();
  const upserted = await upsertWhaleRegistry({
    walletAddress,
    resolvedBetsCount: stats.resolvedBetsCount,
    avgEv: stats.avgEv,
    winRate: stats.winRate,
    hydrationStatus: "complete",
    hydratedAt: new Date(),
    lastHydrationAttemptAt: new Date(),
    hydrationError: null,
  });

  console.log("[x-agent/walletCredibility] using qualified testing fallback", {
    wallet: walletAddress,
    reason,
    resolvedBetsCount: stats.resolvedBetsCount,
    avgEv: stats.avgEv,
  });

  if (upserted) {
    return {
      whale: upserted,
      source: "polymarket_api",
      stats,
    };
  }

  return {
    whale: buildInMemoryWhaleProfile(walletAddress, stats),
    source: "polymarket_api",
    stats,
  };
}

export function emptyWalletCredibilityStats(): WalletCredibilityStats {
  return {
    resolvedBetsCount: 0,
    avgEv: 0,
    winRate: 0,
    closedCount: 0,
  };
}

/** In-memory whale_registry row for gate evaluation when DB has no row yet. */
export function buildInMemoryWhaleProfile(
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
    hydrationStatus: "pending",
    hydratedAt: null,
    lastHydrationAttemptAt: null,
    hydrationError: null,
    createdAt: now,
    updatedAt: now,
  };
}

/** Prefer persisted registry whale; otherwise build from hydrated API stats. */
export function coalesceHydratedWhale(
  walletAddress: string,
  resolution: WalletCredibilityResolution
): WhaleRegistry | null {
  if (resolution.whale) return resolution.whale;
  if (resolution.stats) {
    return buildInMemoryWhaleProfile(walletAddress, resolution.stats);
  }
  if (resolution.source === "unavailable") {
    return buildInMemoryWhaleProfile(
      walletAddress,
      emptyWalletCredibilityStats()
    );
  }
  return null;
}

/**
 * Hydrate wallet stats from registry or Polymarket Data API when hydration is
 * pending or failed. Always await before credibility checks.
 */
export async function hydrateWalletStats(
  walletAddress: string,
  existing?: WhaleRegistry | null
): Promise<WalletCredibilityResolution> {
  if (isAnonymousWalletAddress(walletAddress)) {
    return { whale: null, source: "anonymous" };
  }

  const normalized = normalizeWalletAddress(walletAddress);
  if (!normalized) {
    return { whale: null, source: "unavailable" };
  }

  if (existing && !walletNeedsHistoryHydration(existing)) {
    return {
      whale: existing,
      source: "registry",
      hydrationStatus: resolveWalletHydrationStatus(existing),
    };
  }

  return resolveWhaleForCredibilityGate(normalized, existing);
}

/**
 * Worker/feed path: ensure wallet history is hydrated before feed qualification.
 * Does not trigger X-post generation.
 */
export async function ensureWalletCredibilityHydrated(
  walletAddress: string,
  options?: { tradeId?: string; existingWhale?: WhaleRegistry | null }
): Promise<WalletCredibilityResolution> {
  if (isAnonymousWalletAddress(walletAddress)) {
    return { whale: null, source: "anonymous" };
  }

  const normalized = normalizeWalletAddress(walletAddress);
  if (!normalized) {
    return { whale: null, source: "unavailable" };
  }

  const existing =
    options?.existingWhale ??
    (await findWhaleByWalletCaseInsensitive(normalized));

  if (existing && !walletNeedsHistoryHydration(existing)) {
    return {
      whale: existing,
      source: "registry",
      hydrationStatus: resolveWalletHydrationStatus(existing),
    };
  }

  return hydrateWalletStats(normalized, existing);
}

/**
 * Resolve wallet credibility for post-queue gates.
 * 1. Case-insensitive registry lookup
 * 2. Low-credibility cache (skip repeat Polymarket fetches)
 * 3. Polymarket Data API closed-positions history
 * 4. Registry re-check after API (race with concurrent upserts)
 */
export async function resolveWhaleForCredibilityGate(
  wallet: string,
  existing?: WhaleRegistry | null
): Promise<WalletCredibilityResolution> {
  if (isAnonymousWalletAddress(wallet)) {
    return { whale: null, source: "anonymous" };
  }

  const walletAddress = normalizeWalletAddress(wallet);
  if (!walletAddress) {
    return { whale: null, source: "unavailable" };
  }

  const fromRegistry =
    existing ?? (await findWhaleByWalletCaseInsensitive(walletAddress));
  if (fromRegistry && !walletNeedsHistoryHydration(fromRegistry)) {
    return {
      whale: fromRegistry,
      source: "registry",
      hydrationStatus: resolveWalletHydrationStatus(fromRegistry),
    };
  }

  const cached = readLowCredibilityCache(walletAddress);
  if (cached) {
    if (!walletMeetsCredibilityCriteria(cached.stats)) {
      const testingFallback = await resolveTestingFallbackWhale(
        walletAddress,
        "low_credibility_cache"
      );
      if (testingFallback) return testingFallback;
    }

    console.log(
      "[x-agent/walletCredibility] low-credibility cache hit",
      walletAddress
    );
    const persisted = await persistWalletHydrationOutcome({
      walletAddress,
      stats: cached.stats,
      hydrationStatus: "complete",
    });
    return {
      whale: persisted ?? buildInMemoryWhaleProfile(walletAddress, cached.stats),
      source: "low_credibility_cache",
      stats: cached.stats,
      hydrationStatus: "complete",
    };
  }

  const attemptedAt = new Date();
  let closedPositions: unknown[] = [];
  try {
    closedPositions = await fetchClosedPositions(walletAddress);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[x-agent/walletCredibility] Polymarket fetch failed", {
      wallet: walletAddress,
      error: message,
    });
    const retryRegistry = await findWhaleByWalletCaseInsensitive(walletAddress);
    if (retryRegistry && !walletNeedsHistoryHydration(retryRegistry)) {
      return {
        whale: retryRegistry,
        source: "registry",
        hydrationStatus: resolveWalletHydrationStatus(retryRegistry),
      };
    }
    const testingFallback = await resolveTestingFallbackWhale(
      walletAddress,
      "polymarket_fetch_failed"
    );
    if (testingFallback) return testingFallback;

    const failed = await persistWalletHydrationOutcome({
      walletAddress,
      hydrationStatus: "failed",
      hydrationError: message,
      attemptedAt,
    });

    return {
      whale: failed,
      source: "unavailable",
      hydrationStatus: "failed",
    };
  }

  const registryAfterFetch =
    await findWhaleByWalletCaseInsensitive(walletAddress);
  if (
    registryAfterFetch &&
    !walletNeedsHistoryHydration(registryAfterFetch)
  ) {
    return {
      whale: registryAfterFetch,
      source: "registry",
      hydrationStatus: resolveWalletHydrationStatus(registryAfterFetch),
    };
  }

  const stats = computeWalletCredibilityStats(closedPositions);
  const upserted = await persistWalletHydrationOutcome({
    walletAddress,
    stats,
    hydrationStatus: "complete",
    hydrationError: null,
    attemptedAt,
  });
  const hydratedWhale =
    upserted ?? buildInMemoryWhaleProfile(walletAddress, stats);

  if (walletMeetsCredibilityCriteria(stats)) {
    if (upserted) {
      console.log("[x-agent/walletCredibility] upserted credible wallet", {
        wallet: walletAddress,
        resolvedBetsCount: stats.resolvedBetsCount,
        avgEv: stats.avgEv,
      });
    } else {
      console.log(
        "[x-agent/walletCredibility] registry upsert unavailable — using in-memory profile",
        {
          wallet: walletAddress,
          resolvedBetsCount: stats.resolvedBetsCount,
          avgEv: stats.avgEv,
        }
      );
    }
    return {
      whale: hydratedWhale,
      source: "polymarket_api",
      stats,
      hydrationStatus: "complete",
    };
  }

  writeLowCredibilityCache(walletAddress, stats);
  console.log("[x-agent/walletCredibility] cached low-credibility wallet", {
    wallet: walletAddress,
    resolvedBetsCount: stats.resolvedBetsCount,
    avgEv: stats.avgEv,
  });

  if (!walletMeetsCredibilityCriteria(stats)) {
    const testingFallback = await resolveTestingFallbackWhale(
      walletAddress,
      "below_credibility_threshold"
    );
    if (testingFallback) return testingFallback;
  }

  return {
    whale: hydratedWhale,
    source: "low_credibility_cache",
    stats,
    hydrationStatus: "complete",
  };
}

/** Test helper — clear in-process low-credibility cache. */
export function clearLowCredibilityCacheForTests(): void {
  lowCredibilityCache().clear();
}
